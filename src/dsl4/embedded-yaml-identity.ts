import type {SourceDocumentReference} from '@kubohiroya/turbowarp-document-data/composition';
export const kamishibaiEmbeddedYamlProviderId = 'kamishibai-dsl4';
export const kamishibaiEmbeddedYamlDocumentId = 'story';
export const kamishibaiEmbeddedYamlReference: Readonly<SourceDocumentReference> = Object.freeze({
  providerId: kamishibaiEmbeddedYamlProviderId,
  documentId: kamishibaiEmbeddedYamlDocumentId,
});
export const dsl4EmbeddedYamlHatOperation = 'embeddedYaml';
export const dsl4EmbeddedYamlHatOpcode = 'kubohiroyakamishibairuntime4_embeddedYaml';
export const dsl4BundledEmbeddedYamlHatOpcode =
  'kubohiroyakamishibai4_kubohiroyakamishibairuntime4__embeddedYaml';

export const dsl4EmbeddedYamlConfigHatOperation = 'embeddedYamlConfig';
export const dsl4EmbeddedYamlConfigHatOpcode = 'kubohiroyakamishibairuntime4_embeddedYamlConfig';
export const dsl4BundledEmbeddedYamlConfigHatOpcode =
  'kubohiroyakamishibai4_kubohiroyakamishibairuntime4__embeddedYamlConfig';

export const dsl4EmbeddedYamlRootOperation = 'embeddedYamlRoot';
export const dsl4EmbeddedYamlRootOpcode = 'kubohiroyakamishibairuntime4_embeddedYamlRoot';
export const dsl4BundledEmbeddedYamlRootOpcode =
  'kubohiroyakamishibai4_kubohiroyakamishibairuntime4__embeddedYamlRoot';
