// Questlog language pack engine: Bergamot (Marian) WASM with Firefox's en-it / it-en models, run from Node.
// Contract (server/translate/worker.mjs): load(dir, from, to) loads ONE direction, translate(texts, from, to).
// Layout of dir: bergamot-translator-worker.{js,wasm}, enit/ and iten/ (model, lexicon, vocabulary).
// The text pipeline protects names, code and emphasis as ⟦n⟧ placeholders. The engine copies them through
// untouched as unknown tokens (measured: 80 of 80 sentences, both directions), so no mapping is needed; its HTML
// mode was tried and is worse (it eats the spaces around the tags).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';

let dir, mod, service, model, pair;

export async function load(d, from, to) {
  dir = d;
  pair = from + to;
  const wasm = readFileSync(join(dir, 'bergamot-translator-worker.wasm'));
  const Module = {};
  const gemmNames = {
    int8_prepare_a: 'int8PrepareAFallback',
    int8_prepare_b: 'int8PrepareBFallback',
    int8_prepare_b_from_transposed: 'int8PrepareBFromTransposedFallback',
    int8_prepare_b_from_quantized_transposed: 'int8PrepareBFromQuantizedTransposedFallback',
    int8_prepare_bias: 'int8PrepareBiasFallback',
    int8_multiply_and_add_bias: 'int8MultiplyAndAddBiasFallback',
    int8_select_columns_of_b: 'int8SelectColumnsOfBFallback',
  };
  const gemm = Object.fromEntries(Object.entries(gemmNames).map(([k, n]) => [k, (...a) => Module.asm[n](...a)]));
  mod = await new Promise((resolve, reject) => {
    Object.assign(Module, {
      instantiateWasm: (info, accept) => {
        WebAssembly.instantiate(wasm, { ...info, wasm_gemm: gemm })
          .then(({ instance }) => accept(instance)).catch(reject);
        return {};
      },
      onRuntimeInitialized: () => resolve(Module),
    });
    globalThis.Module = Module;
    globalThis.require = createRequire(join(dir, 'x.cjs'));
    globalThis.__dirname = dir;
    vm.runInThisContext(readFileSync(join(dir, 'bergamot-translator-worker.js'), 'utf8'), { filename: 'bergamot.js' });
  });
  service = new mod.BlockingService({ cacheSize: 0 });
  model = loadModel(pair);
}

function aligned(buf, align) {
  const bytes = new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const m = new mod.AlignedMemory(bytes.byteLength, align);
  m.getByteArrayView().set(bytes);
  return m;
}

function loadModel(key) {
  const rd = (n) => readFileSync(join(dir, key, n));
  const cfg = `beam-size: 1
normalize: 1.0
word-penalty: 0
cpu-threads: 0
gemm-precision: int8shiftAlphaAll
skip-cost: true
alignment: soft
quiet: true
quiet-translation: true
max-length-break: 128
mini-batch-words: 1024
workspace: 128
max-length-factor: 2.0
`;
  const vocabs = new mod.AlignedMemoryList();
  vocabs.push_back(aligned(rd(`vocab.${key}.spm`), 64));
  return new mod.TranslationModel(cfg, aligned(rd(`model.${key}.intgemm.alphas.bin`), 256),
    aligned(rd(`lex.50.50.${key}.s2t.bin`), 64), vocabs, null);
}

export async function translate(texts, from, to) {
  if (from + to !== pair) throw new Error(`pair ${from}>${to} not loaded (have ${pair})`);
  const input = new mod.VectorString();
  texts.forEach((t) => input.push_back(t));
  const opts = new mod.VectorResponseOptions();
  texts.forEach(() => opts.push_back({ alignment: false, html: false, qualityScores: false }));
  const res = service.translate(model, input, opts);
  input.delete(); opts.delete();
  const out = texts.map((_, i) => res.get(i).getTranslatedText());
  res.delete();
  return out;
}
