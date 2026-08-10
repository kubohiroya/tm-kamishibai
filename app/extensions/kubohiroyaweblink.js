// Name: Web Link
// ID: kubohiroyaweblink
// Description: Open an HTTPS URL in a new browser tab.
// By: Hiroya Kubo
// License: MPL-2.0

/* global Scratch */

(function (Scratch) {
  'use strict';

  class WebLinkExtension {
    getInfo() {
      return {
        id: 'kubohiroyaweblink',
        name: 'Web Link',
        color1: '#007F71',
        blocks: [
          {
            opcode: 'openUrl',
            blockType: Scratch.BlockType.COMMAND,
            text: 'open [URL] in a new tab',
            hideFromPalette: true,
            arguments: {
              URL: {
                type: Scratch.ArgumentType.STRING,
                defaultValue: 'https://example.com/',
              },
            },
          },
        ],
      };
    }

    async openUrl(args) {
      const url = Scratch.Cast.toString(args.URL);
      if (!url.startsWith('https://')) {
        throw new Error(`Web Link only opens HTTPS URLs: ${url}`);
      }
      await Scratch.openWindow(url);
    }
  }

  if (!Scratch.extensions.unsandboxed) {
    throw new Error('Web Link must run unsandboxed to open browser tabs.');
  }
  Scratch.extensions.register(new WebLinkExtension());
})(Scratch);
