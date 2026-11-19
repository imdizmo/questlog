/**
 * Questlog's formula language: game rules written as small typed expressions, e.g.
 * `roll(attacker.damage) * table(kindVsMaterial, attacker.kind, target.material)`.
 * Parsed by our own parser into a JSON expression tree, type-checked against the roles' fields, and run by a plain
 * interpreter with one seeded generator. No eval, no dynamic code.
 */
export { FormulaError, own, type FormulaProblem } from './lexer';
export { parseFormula, FORMULA_LANGUAGE_VERSION, MAX_FORMULA_LENGTH, MAX_DEPTH, type Expr, type BinaryOp, type UnaryOp, type ParseResult } from './parser';
export {
  checkFormula, completions, calledRules, findRuleCycle, closest, fieldType, describe, isBuiltin, tableRefName, FUNCTIONS,
  type FType, type FormulaScope, type ScopeRole, type RuleSig, type TableSig, type TableData, type TableKey, type TableMode,
  type CheckResult, type Completion, type CompletionKind, type FnInfo,
} from './check';
export { evaluate, evaluateRule, MAX_RULE_DEPTH, MAX_STEPS, type StepBudget, type Value, type FormulaEnv, type RuleProgram } from './eval';
export { makeRng, splitmix32, runSeed, RANDOM_INFO, type Rng } from './random';
