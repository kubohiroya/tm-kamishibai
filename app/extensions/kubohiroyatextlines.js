// Name: Text Lines
// ID: kubohiroyatextlines
// Description: Count, read, and split text by lines in TurboWarp.
// By: Hiroya Kubo
// License: MPL-2.0

(function (Scratch) {
  'use strict';

  const extensionName = "Text Lines";
  const blocks = [{ "opcode": "lineCount", "blockType": "REPORTER", "text": "number of lines in [TEXT]", "description": "Returns the number of lines in the supplied text.", "arguments": { "TEXT": { "type": "STRING", "defaultValue": "first line\nsecond line" } } }, { "opcode": "lineAt", "blockType": "REPORTER", "text": "line [LINE] of [TEXT]", "description": "Returns one line using a one-based line number. Invalid line numbers return an empty string.", "arguments": { "TEXT": { "type": "STRING", "defaultValue": "first line\nsecond line" }, "LINE": { "type": "NUMBER", "defaultValue": 1 } } }, { "opcode": "writeLinesToList", "blockType": "COMMAND", "text": "put lines of [TEXT] into list [LIST]", "description": "Replaces the contents of the named Scratch list with the lines of the supplied text.", "arguments": { "TEXT": { "type": "STRING", "defaultValue": "first line\nsecond line" }, "LIST": { "type": "STRING", "menu": "LIST_MENU" } } }];
  const definitions = {
    extensionName,
    blocks
  };
  const blockDefinitions = definitions.blocks;
  class TextLinesExtension {
    getInfo() {
      const translate = Scratch.translate;
      return {
        id: "kubohiroyatextlines",
        name: translate(definitions.extensionName),
        docsURI: "https://kubohiroya.github.io/turbowarp-text-lines/",
        color1: "#5B80A5",
        blocks: blockDefinitions.map((block) => this.toScratchBlock(block)),
        menus: {
          LIST_MENU: {
            acceptReporters: true,
            items: "getLists"
          }
        }
      };
    }
    getLists() {
      const stage = Scratch.vm.runtime.getTargetForStage();
      const editingTarget = Scratch.vm.editingTarget;
      const lists = [
        ...stage ? Object.values(stage.variables) : [],
        ...editingTarget && editingTarget !== stage ? Object.values(editingTarget.variables) : []
      ].filter((variable) => variable.type === "list");
      if (lists.length === 0) return [""];
      return lists.map((list) => ({ text: list.name, value: list.id }));
    }
    lineCount(args) {
      return splitLines(Scratch.Cast.toString(args.TEXT)).length;
    }
    lineAt(args) {
      const lines = splitLines(Scratch.Cast.toString(args.TEXT));
      const line = Math.trunc(Scratch.Cast.toNumber(args.LINE));
      if (!Number.isFinite(line) || line < 1 || line > lines.length) return "";
      return lines[line - 1] ?? "";
    }
    writeLinesToList(args, util) {
      const listIdOrName = Scratch.Cast.toString(args.LIST);
      const stage = Scratch.vm.runtime.getTargetForStage();
      const variable = util.target.lookupVariableById(listIdOrName) ?? stage?.lookupVariableById(listIdOrName) ?? util.target.lookupVariableByNameAndType(listIdOrName, "list") ?? stage?.lookupVariableByNameAndType(listIdOrName, "list");
      if (!variable || variable.type !== "list") throw new Error(`List not found: ${listIdOrName}`);
      variable.value = splitLines(Scratch.Cast.toString(args.TEXT));
      variable._monitorUpToDate = false;
    }
    toScratchBlock(block) {
      return {
        opcode: block.opcode,
        blockType: Scratch.BlockType[block.blockType],
        text: Scratch.translate(block.text),
        arguments: Object.fromEntries(
          Object.entries(block.arguments).map(([name, argument]) => [
            name,
            Object.fromEntries(
              Object.entries({
                type: Scratch.ArgumentType[argument.type],
                defaultValue: argument.defaultValue,
                menu: argument.menu
              }).filter(([, value]) => value !== void 0)
            )
          ])
        )
      };
    }
  }
  function splitLines(text) {
    return text.split(/\r\n|\n|\r/);
  }
  if (!Scratch.extensions.unsandboxed) {
    throw new Error("Text Lines must run unsandboxed to write to Scratch lists.");
  }
  Scratch.extensions.register(new TextLinesExtension());

})(Scratch);
