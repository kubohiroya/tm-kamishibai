export {fitDsl4PublicationStage} from '../browser-stage-layout.js';

/** Reserve a separate control row instead of painting controls over the chapter canvas. */
export function createDsl4PublicationLayout(document: Document) {
  const layout = document.createElement('div');
  layout.dataset.dsl4PublicationLayout = 'true';
  layout.style.cssText =
    'position:absolute;inset:0;display:grid;grid-template-rows:minmax(0,1fr) auto;background:white;';
  const stageMount = document.createElement('div');
  stageMount.dataset.dsl4PublicationViewport = 'true';
  stageMount.style.cssText =
    'position:relative;min-width:0;min-height:0;overflow:hidden;box-sizing:border-box;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
  const controls = document.createElement('div');
  controls.dataset.dsl4Publication = 'true';
  controls.dataset.kamishibaiKeymapIgnore = 'true';
  controls.style.cssText =
    'position:relative;min-width:0;max-height:6em;overflow:auto;background:white;padding:6px;overflow-wrap:anywhere;';
  for (const type of ['keydown', 'keyup', 'pointerup']) {
    controls.addEventListener(type, (event) => event.stopPropagation());
  }
  layout.append(stageMount, controls);
  return {layout, stageMount, controls};
}
