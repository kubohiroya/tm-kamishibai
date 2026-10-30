type ObjectRecord = Record<string, unknown>;
const record = (value: unknown): value is ObjectRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
/** Copy only representation-editable state; immutable archive payloads retain their references. */
export function cloneKamishibaiDocumentProject<T extends ObjectRecord>(project: T): T {
  const copy: ObjectRecord = {...project};
  if (Array.isArray(project.extensions)) copy.extensions = [...project.extensions];
  if (record(project.extensionURLs)) copy.extensionURLs = {...project.extensionURLs};
  if (Array.isArray(project.targets))
    copy.targets = project.targets.map((target) => {
      if (!record(target)) return target;
      const cloned: ObjectRecord = {...target};
      if (record(target.blocks)) cloned.blocks = structuredClone(target.blocks);
      if (record(target.comments)) cloned.comments = structuredClone(target.comments);
      return cloned;
    });
  if (record(project.extensionStorage)) {
    const storage: ObjectRecord = {...project.extensionStorage};
    copy.extensionStorage = storage;
    const component = (value: unknown): unknown => {
      if (!record(value)) return value;
      const cloned: ObjectRecord = {...value};
      if (record(value.editorViews)) cloned.editorViews = structuredClone(value.editorViews);
      return cloned;
    };
    if (record(storage.kubohiroyakamishibai4)) {
      const bundle: ObjectRecord = {...storage.kubohiroyakamishibai4};
      storage.kubohiroyakamishibai4 = bundle;
      if (record(bundle.components)) {
        const components: ObjectRecord = {...bundle.components};
        bundle.components = components;
        if (Object.hasOwn(components, 'kubohiroyakamishibairuntime4'))
          components.kubohiroyakamishibairuntime4 = component(
            components.kubohiroyakamishibairuntime4,
          );
      }
    }
    if (Object.hasOwn(storage, 'kubohiroyakamishibairuntime4'))
      storage.kubohiroyakamishibairuntime4 = component(storage.kubohiroyakamishibairuntime4);
  }
  return copy as T;
}
