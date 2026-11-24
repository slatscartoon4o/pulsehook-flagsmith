/**
 * 诚实结论：Primary 与 Guardrail 冲突时不下全量结论。
 */
export function verdictFor({ primary, guardrail, totalExposures }) {
  const pInf = primary?.inference ?? null;
  const gInf = guardrail?.inference ?? null;
  if (!pInf || totalExposures < 100) {
    return { tone: 'pending', summary: 'Not enough data for a decision yet.' };
  }
  const primaryWins = pInf.chance_to_win > 0.95 && pInf.ci_low > 0;
  const guardrailDrops = gInf !== null && gInf.ci_high < 0;
  if (primaryWins && guardrailDrops) {
    return {
      tone: 'mixed',
      summary:
        'Primary metric clears the bar but the guardrail regresses. Do not roll the sandbox out at 100%.',
      detail:
        'The sandbox raises first_api_call_succeeded with an interval strictly above zero, while ' +
        'sdk_snippet_exported falls with an interval strictly below zero: some developers finish playing ' +
        'in the browser and leave without exporting the code. Ship a v2 that auto-surfaces the export ' +
        'card after the first successful call, then re-test with the guardrail as the primary metric.',
    };
  }
  if (primaryWins && !guardrailDrops) {
    return { tone: 'good', summary: 'Primary up, guardrail holding. A clean ship.', detail: '' };
  }
  if (!primaryWins && guardrailDrops) {
    return { tone: 'bad', summary: 'No primary win and a guardrail regression. Keep control.', detail: '' };
  }
  return { tone: 'pending', summary: 'Inconclusive: the credible interval still spans zero.', detail: '' };
}
