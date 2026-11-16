import { describe, it, expect } from 'vitest';
import { applySet, evalCond, fillText, parseLabel, parseVars } from '../shared/story';

describe('story flow language', () => {
  const vars = parseVars('gold = 10\nhas_key = false\nname = "Ada"\nnot a line\n');
  const visits = (t: string) => (t === 'The gate' ? 2 : 0);
  it('reads starting values', () => expect(vars).toEqual({ gold: 10, has_key: false, name: 'Ada' }));
  it('splits a label', () => {
    expect(parseLabel('Open the door {if has_key} {set gold -= 5} {if gold >= 5}')).toEqual({ text: 'Open the door', cond: 'has_key and gold >= 5', sets: ['gold -= 5'] });
    expect(parseLabel('Walk on')).toEqual({ text: 'Walk on', cond: null, sets: [] });
  });
  it('evaluates conditions', () => {
    expect(evalCond('gold >= 10', vars, visits)).toBe(true);
    expect(evalCond('gold > 10', vars, visits)).toBe(false);
    expect(evalCond('has_key', vars, visits)).toBe(false);
    expect(evalCond('!has_key and name == Ada', vars, visits)).toBe(true);
    expect(evalCond('has_key or seen The gate', vars, visits)).toBe(true);
    expect(evalCond('!seen The gate', vars, visits)).toBe(false);
    expect(evalCond('unknown > 0', vars, visits)).toBe(false);
    expect(evalCond('name > 3', vars, visits)).toBe(false);
  });
  it('applies changes', () => {
    expect(applySet('gold -= 4', vars).gold).toBe(6);
    expect(applySet('fresh += 2', vars).fresh).toBe(2);
    expect(applySet('has_key = true', vars).has_key).toBe(true);
    expect(applySet('gold += lots', vars)).toBe(vars);
    expect(applySet('nonsense', vars)).toBe(vars);
  });
  it('fills text', () => expect(fillText('You have {gold} gold, {nobody}.', vars)).toBe('You have 10 gold, {nobody}.'));
});
