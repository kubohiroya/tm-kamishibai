import canonicalSchema from '../../schema/dsl-4.schema.json' with {type: 'json'};

type Schema = {[key: string]: unknown};
const definitions = canonicalSchema.$defs as Record<string, Schema>;
const editorRoots = {
  asset: ['asset', '素材'],
  control: ['keymap', '操作キー'],
  actor: ['assetId', '登場人物の初期コスチューム'],
  textStyle: ['textStyle', '文字スタイル'],
  variable: ['variableValue', '変数の初期値'],
  cover: ['cover', '表紙'],
  loading: ['loadingScreen', '読み込み画面'],
  recognition: ['poseRecognition', 'ポーズ・画像認識'],
} as const;

const titles: Record<string, string> = {
  compactAsset: 'SB3内の同名素材（短形式）',
  namedBackdrop: '背景',
  namedSound: '音',
  namedCostume: 'コスチューム',
  namedRecognitionModel: '認識モデル',
  namedImage: '操作アイコン画像',
  kind: '素材の種類',
  name: 'SB3内の素材名',
  file: '作品フォルダー内のパス',
  target: '対象アクター',
  source: 'Web上の入手元',
  url: 'HTTPS URL',
  loading: '準備する時期',
  delivery: '配布方法',
  retention: '保持する期間',
  backdrop: '背景アセットID',
  bgm: 'BGMアセットID',
  costumes: 'コスチュームのアセットID',
  size: '大きさ',
  color: '色',
  idleSound: '認識待ちの音',
  chargeSound: '認識完了の音',
  preview: 'カメラプレビュー',
  mirroring: '左右反転',
  modelInitialization: 'モデル初期化',
  sequence: '順番にポーズを行う',
  selection: 'ポーズで選択する',
  feedback: '認識の表示',
  navigation: '場面の移動',
  overlay: '関節とボーンの表示',
  controls: 'カメラ操作ボタン',
  bitmapResolution: '画像の解像度倍率',
};

/** Expand provider constraints into complete forms, avoiding RJSF's untyped true-schema fields. */
function assetVariants(): Schema {
  const variants: Schema[] = [{$ref: '#/$defs/compactAsset'}];
  for (const entry of definitions.asset!.oneOf as {$ref: string}[]) {
    const name = entry.$ref.slice('#/$defs/'.length);
    if (name === 'compactAsset') continue;
    const {oneOf, properties, required, ...base} = definitions[name]!;
    for (const branch of oneOf as Schema[]) {
      const needed = branch.required as string[];
      const provider = ['name', 'file', 'source'].find((key) => needed.includes(key))!;
      const providerTitle = {
        name: 'SB3内の素材',
        file: '作品フォルダーのファイル',
        source: 'Web上のファイル',
      }[provider];
      const props = Object.fromEntries(
        Object.entries(properties as Schema).filter(
          ([key]) => !['name', 'file', 'source'].includes(key) || key === provider,
        ),
      );
      for (const [key, constraint] of Object.entries(branch.properties as Schema)) {
        if (constraint !== true)
          props[key] = {...(props[key] as Schema), ...(constraint as Schema)};
      }
      variants.push({
        ...base,
        title: `${titles[name]} — ${providerTitle}`,
        properties: props,
        required: [...new Set([...(required as string[]), ...needed])],
      });
    }
  }
  return {oneOf: variants};
}

/** Project only the reachable canonical definitions into the editor's draft-07 dialect. */
function editorSchema(root: string, title: string): Schema {
  const selected: Record<string, Schema> = {};
  function convert(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(convert);
    if (typeof value !== 'object' || value === null) return value;
    const source = value as Schema;
    const result: Schema = {};
    for (const [key, child] of Object.entries(source)) {
      // Defaults must not add optional properties to an otherwise unchanged authored value.
      if (key === 'default') continue;
      if (key === '$ref') {
        if (typeof child !== 'string' || !child.startsWith('#/$defs/'))
          throw new TypeError('Authoring editors require local canonical schema references');
        const name = child.slice('#/$defs/'.length);
        if (!Object.hasOwn(selected, name)) {
          const definition = definitions[name];
          if (!definition) throw new TypeError(`Missing authoring schema definition: ${name}`);
          selected[name] = {};
          selected[name] = convert(definition) as Schema;
          if (titles[name]) selected[name].title = titles[name];
        }
        result.$ref = `#/definitions/${name}`;
      } else if (key === 'const') {
        result.enum = [child];
        result.type ??= typeof child;
      } else if (key === 'dependentRequired') result.dependencies = convert(child);
      else if (key === 'prefixItems') result.items = convert(child);
      else if (key === 'items' && Object.hasOwn(source, 'prefixItems'))
        result.additionalItems = convert(child);
      else if (key === 'properties') {
        result.properties = Object.fromEntries(
          Object.entries(child as Schema).map(([name, property]) => {
            const projected = convert(property);
            const required = (source.required as string[] | undefined)?.includes(name);
            const original = property as Schema;
            const referenced =
              typeof original?.$ref === 'string'
                ? definitions[original.$ref.slice('#/$defs/'.length)]
                : original;
            // An impossible null branch leaves an absent optional object absent in RJSF.
            // The real branch retains every canonical constraint and is selected for existing data.
            const field =
              !required && referenced?.type === 'object'
                ? {
                    oneOf: [
                      {type: 'null', not: {}, title: '設定しない'},
                      {...(projected as Schema), title: `${titles[name] ?? name}を設定`},
                    ],
                  }
                : projected;
            return [
              name,
              typeof field === 'object' && field !== null
                ? {...(field as Schema), ...(titles[name] ? {title: titles[name]} : {})}
                : field,
            ];
          }),
        );
      } else result[key] = convert(child);
    }
    return result;
  }
  const schema = convert(root === 'asset' ? assetVariants() : {$ref: `#/$defs/${root}`}) as Schema;
  if (root === 'variableValue') {
    const variants = selected.variableValue!.oneOf as Schema[];
    ['文字列', '数値', '真偽値'].forEach((label, index) => (variants[index]!.title = label));
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...schema,
    title,
    definitions: selected,
  };
}

export const dsl4BlockAuthoringEditorIcon =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect x="6" y="4" width="28" height="32" rx="4" fill="white"/><path d="M12 13h16M12 20h16M12 27h10" stroke="#683f8f" stroke-width="3"/></svg>',
  );

/** Serializable registrations; the GUI owns the schema form, draft, validation and commit. */
export function createDsl4BlockAuthoringEditorDefinitions(extensionId: string) {
  return Object.entries(editorRoots).map(([opcode, [root, title]]) => ({
    apiVersion: 1,
    extensionId,
    editorId: `definition-${opcode}`,
    opcodes: [`${extensionId}_${opcode}`],
    argument: 'VALUE',
    format: 'json',
    schema: editorSchema(root, title),
  }));
}
