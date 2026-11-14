/**
 * Independent expectation of the supported on-device timed program.
 * Keeping this separate from the client compiler catches missing heater-off,
 * unit mistakes, changed instruction order, and unsupported instruction types.
 */
export function decodeRecipe(value: unknown): {
  uuid: string;
  temperature: number;
  duration: number;
} {
  const recipe = value as {
    initialStep?: unknown;
    recipeSource?: unknown;
    instructions?: {
      uuid?: unknown;
      stg?: { stp?: { instr?: Record<string, Record<string, unknown>>[] }[] }[];
    };
  };
  if (recipe?.initialStep !== 0 || recipe.recipeSource !== 'manual')
    throw new Error('Unsupported recipe envelope.');
  const instructions = recipe.instructions;
  const steps = instructions?.stg?.[0]?.stp;
  const commands = steps?.[0]?.instr;
  if (instructions?.stg?.length !== 1 || steps?.length !== 1 || commands?.length !== 7)
    throw new Error('Expected exactly one bounded timed phase.');
  if (typeof instructions.uuid !== 'string' || !/^[0-9a-f-]{36}$/.test(instructions.uuid))
    throw new Error('Invalid cook UUID.');
  const temperature = commands[3]?.heater?.temp_sp;
  const duration = commands[2]?.timer?.down_from_n;
  if (
    typeof temperature !== 'number' ||
    !Number.isFinite(temperature) ||
    temperature < 20 ||
    temperature > 90
  )
    throw new Error('Temperature outside manual limits.');
  if (
    typeof duration !== 'number' ||
    !Number.isInteger(duration) ||
    duration < 10 ||
    duration > 86400
  )
    throw new Error('Timer outside manual limits.');
  const expected = [
    { appliance: { mode: 23 } },
    { timer: { id: 0, action_n: 3 } },
    { timer: { id: 0, down_from_n: duration, action_n: 1, usage: 6, autostart: 0 } },
    { heater: { id: 0, temp_sp: temperature, preheat: 0, action_n: 1 } },
    { wait: { timer: 0 } },
    { heater: { id: 0, action_n: 0 } },
    { timer: { id: 0, action_n: 3 } },
  ];
  // Key order is deliberately irrelevant.
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => [key, canonical(v)]),
      );
    return item;
  };
  if (JSON.stringify(canonical(commands)) !== JSON.stringify(canonical(expected)))
    throw new Error('The mock rejected an unrecognized or unbounded program.');
  return { uuid: instructions.uuid, temperature, duration };
}
