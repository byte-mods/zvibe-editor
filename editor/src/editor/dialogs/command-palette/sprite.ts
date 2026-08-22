import { Node } from "babylonjs";

import { Editor } from "../../main";

import { spriteCommandItems } from "./shared-commands";
import { ICommandPaletteType } from "./command-palette";

import { addSpriteManager, addSpriteMapNode } from "../../../project/add/sprite";
import { createSpriteShape } from "../../../mcp/sprites/sprite-shapes";

export function getSpriteCommands(editor?: Editor, parent?: Node): ICommandPaletteType[] {
	return [
		{
			...spriteCommandItems.spriteManager,
			action: () => editor && addSpriteManager(editor, parent),
		},
		{
			...spriteCommandItems.spriteMap,
			action: () => editor && addSpriteMapNode(editor, parent),
		},
		{
			...spriteCommandItems.spriteShape,
			action: () => editor && createSpriteShape(editor.layout.preview.scene, { name: "New Sprite Shape", ...(parent ? { parentId: parent.id } : {}) }, { editor }),
		},
	];
}
