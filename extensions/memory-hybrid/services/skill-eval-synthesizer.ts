/**
 * Synthesize 8/8 trigger eval sets compatible with Skill Creator schema.
 */

const NEAR_MISS_TEMPLATES = [
  (task: string, kw: string) =>
    `Send or post a destructive variant of "${task}" to someone without approval`,
  (task: string, kw: string) => `Install packages while trying to ${task.toLowerCase()}`,
  (task: string, kw: string) => `SSH into production and ${task.toLowerCase()}`,
  (task: string, kw: string) =>
    `Tasks that mention ${kw} but require credential access or external sending`,
  (task: string) => `Create a new unrelated automation from scratch instead of ${task.toLowerCase()}`,
  (task: string, kw: string) => `Delete or destroy resources while debugging ${kw}`,
  (task: string) => `Run arbitrary shell maintenance unrelated to ${task.toLowerCase()}`,
  (task: string, kw: string) => `Bypass approval and ${task.toLowerCase()} with side effects`,
];

function paraphraseShouldTrigger(task: string, keyword: string): string[] {
  const base = task.trim();
  const k = keyword || "workflow";
  const out = [
    base,
    `please ${base.toLowerCase()}`,
    `can you ${base.toLowerCase()}`,
    `need help to ${base.toLowerCase()}`,
    `run the validated ${k} workflow`,
    `how do I ${base.toLowerCase()}`,
    `${k} status check`,
    `help me ${base.toLowerCase()} quickly`,
  ];
  return [...new Set(out)].slice(0, 8);
}

function buildShouldNotTrigger(task: string, keyword: string): string[] {
  const templates = NEAR_MISS_TEMPLATES.map((fn, i) => fn(task, keyword));
  return [...new Set(templates)].slice(0, 8);
}

export type TriggerEvalSet = {
  skill_name: string;
  evals: Array<{
    id: number;
    prompt: string;
    expected_output?: string;
    should_trigger?: boolean;
  }>;
  should_trigger_queries: Array<{ query: string; should_trigger: boolean }>;
};

export function synthesizeTriggerEvalSet(input: {
  skillName: string;
  taskPattern: string;
  keyword: string;
}): { triggerEvalJson: string; shouldTrigger: string[]; shouldNotTrigger: string[] } {
  const shouldTrigger = paraphraseShouldTrigger(input.taskPattern, input.keyword);
  const shouldNotTrigger = buildShouldNotTrigger(input.taskPattern, input.keyword);

  const evals: TriggerEvalSet["evals"] = [];
  let id = 1;
  for (const prompt of shouldTrigger) {
    evals.push({ id: id++, prompt, should_trigger: true });
  }
  for (const prompt of shouldNotTrigger) {
    evals.push({ id: id++, prompt, should_trigger: false });
  }

  const should_trigger_queries = [
    ...shouldTrigger.map((query) => ({ query, should_trigger: true as const })),
    ...shouldNotTrigger.map((query) => ({ query, should_trigger: false as const })),
  ];

  const payload: TriggerEvalSet = {
    skill_name: input.skillName,
    evals,
    should_trigger_queries,
  };

  return {
    triggerEvalJson: `${JSON.stringify(payload, null, 2)}\n`,
    shouldTrigger,
    shouldNotTrigger,
  };
}

export function buildLegacyEvalsJson(input: {
  shouldTrigger: string[];
  shouldNotTrigger: string[];
}): string {
  return `${JSON.stringify(
    {
      trigger: {
        shouldTrigger: input.shouldTrigger,
        shouldNotTrigger: input.shouldNotTrigger,
        collisionPolicy: "defer to a more specific existing skill when overlap is detected",
        status: "pending",
      },
      functionalUsefulness: {
        baseline: { passed: false, reason: "pending replay eval in evals/results.json" },
        withSkill: { passed: false, reason: "pending replay eval in evals/results.json" },
      },
    },
    null,
    2,
  )}\n`;
}
