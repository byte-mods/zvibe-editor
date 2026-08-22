import { dirname, relative } from "path/posix";

import { ReactNode } from "react";

import { FaFilm } from "react-icons/fa";

import { loadCinematicDocument } from "../../cinematic/serialization/document";
import { CinematicDocumentEditor } from "../../cinematic/v2/editor";

import { AssetsBrowserItem } from "./item";

export class AssetBrowserCinematicItem extends AssetsBrowserItem {
	/**
	 * @override
	 */
	protected getIcon(): ReactNode {
		return <FaFilm size="64px" />;
	}

	/**
	 * @override
	 */
	protected async onDoubleClick(): Promise<void> {
		const projectDirectory = this.props.editor.state.projectPath ? dirname(this.props.editor.state.projectPath) : dirname(this.props.absolutePath);
		const identitySeed = relative(projectDirectory, this.props.absolutePath).replace(/\\/g, "/");
		const loaded = await loadCinematicDocument(this.props.absolutePath, { identitySeed });

		this.props.editor.layout.addLayoutTab(
			<CinematicDocumentEditor document={loaded.document} fingerprint={loaded.fingerprint} editor={this.props.editor} absolutePath={this.props.absolutePath} />,
			{
				setAsActiveTab: true,
				title: "Timeline",
			}
		);
	}
}
