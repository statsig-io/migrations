const MAX_RULE_NAME_LENGTH = 100;

export function capRuleName(ruleName: string): string {
  return ruleName.substring(0, MAX_RULE_NAME_LENGTH);
}
