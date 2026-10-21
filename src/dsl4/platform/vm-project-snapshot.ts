function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Packager omits false shadow flags; restore them only at the VM snapshot boundary. */
export function normalizeDsl4VmProjectSnapshot(project: Readonly<Record<string, unknown>>) {
  if (!Array.isArray(project.targets)) return project;
  return {
    ...project,
    targets: project.targets.map((target: unknown) => {
      if (!isRecord(target) || !isRecord(target.blocks)) return target;
      return {
        ...target,
        blocks: Object.fromEntries(
          Object.entries(target.blocks).map(([id, block]) => [
            id,
            isRecord(block) && typeof block.opcode === 'string' && !Object.hasOwn(block, 'shadow')
              ? {...block, shadow: false}
              : block,
          ]),
        ),
      };
    }),
  };
}
