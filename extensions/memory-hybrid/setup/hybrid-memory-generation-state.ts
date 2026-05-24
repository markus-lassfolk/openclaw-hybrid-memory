type ToolExecutor = (...args: unknown[]) => unknown;

interface ToolExecutorOwner {
  generation: number;
  execute: ToolExecutor;
}

export interface HybridMemoryRegistrationState {
  registrationGenerationRef: { value: number };
  toolExecutorsByName: Map<string, ToolExecutorOwner>;
}

declare global {
  // eslint-disable-next-line no-var
  var __openclawHybridMemoryRegistrationState: HybridMemoryRegistrationState | undefined;
}

function createHybridMemoryRegistrationState(): HybridMemoryRegistrationState {
  return {
    registrationGenerationRef: { value: 0 },
    toolExecutorsByName: new Map<string, ToolExecutorOwner>(),
  };
}

export function getHybridMemoryRegistrationState(): HybridMemoryRegistrationState {
  globalThis.__openclawHybridMemoryRegistrationState ??= createHybridMemoryRegistrationState();
  return globalThis.__openclawHybridMemoryRegistrationState;
}

export function setCurrentToolExecutor(toolName: string, generation: number, execute: ToolExecutor): void {
  if (!toolName) return;
  const state = getHybridMemoryRegistrationState();
  state.toolExecutorsByName.set(toolName, { generation, execute });
}

export function resolveCurrentToolExecutor(toolName: string, currentGeneration: number): ToolExecutor | null {
  const state = getHybridMemoryRegistrationState();
  const owner = state.toolExecutorsByName.get(toolName);
  if (!owner) return null;
  if (owner.generation !== currentGeneration) return null;
  return owner.execute;
}

export function clearToolExecutorsForGeneration(generation: number): void {
  const state = getHybridMemoryRegistrationState();
  for (const [toolName, owner] of state.toolExecutorsByName.entries()) {
    if (owner.generation === generation) {
      state.toolExecutorsByName.delete(toolName);
    }
  }
}

export function resetHybridMemoryRegistrationStateForTests(): void {
  const state = getHybridMemoryRegistrationState();
  state.registrationGenerationRef.value = 0;
  state.toolExecutorsByName.clear();
}
