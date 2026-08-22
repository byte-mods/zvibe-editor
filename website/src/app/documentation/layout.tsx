import Link from "next/link";
import type { Metadata } from "next";

import { PropsWithChildren } from "react";
import { IoArrowDownCircleSharp } from "react-icons/io5";

import { Toaster } from "@/components/ui/sonner";

import { DocumentationSidebar } from "./sidebar";

export const metadata: Metadata = {
	title: "Zvibe Editor Developer Documentation",
	description: "Build, script, test, automate, and ship games with Zvibe Editor.",
};

export default function DocumentationLayout(props: PropsWithChildren) {
	return (
		<div className="flex w-screen bg-black">
			<DocumentationSidebar />

			<div className="absolute 2xl:fixed top-0 left-0 flex justify-between items-center w-full px-5">
				<Link href="/" className="flex items-center gap-3 bg-black py-4 text-white">
					<span className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500 via-violet-600 to-cyan-400 text-lg font-black">
						Z
					</span>
					<span className="hidden text-lg font-semibold tracking-tight sm:block">Zvibe Editor</span>
				</Link>

				<Link href="/download" className="flex items-center gap-2 text-black bg-neutral-50 rounded-full px-5 py-2">
					<IoArrowDownCircleSharp className="w-6 h-6" />
					Download
				</Link>
			</div>

			<div className="w-full xl:pl-80">{props.children}</div>

			<Toaster className="dark" />
		</div>
	);
}
