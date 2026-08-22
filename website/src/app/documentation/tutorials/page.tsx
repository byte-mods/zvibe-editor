import type { Metadata } from "next";
import Link from "next/link";

import { tutorials } from "./tutorial-data";

export const metadata: Metadata = {
	title: "Developer Tutorials | Zvibe Editor",
	description: "Complete Zvibe Editor tutorials covering the IDE, TypeScript, game projects, builds, and MCP automation.",
};

const groupDescriptions: Record<(typeof tutorials)[number]["group"], string> = {
	"Start here": "Learn the project window and the reliable edit-test-save loop.",
	"Core workflows": "Author assets, animation, code, systems, settings, and builds.",
	"Build complete games": "Follow end-to-end examples with playable completion criteria.",
	"AI and MCP": "Connect external AI clients and modify the live editor through safe, verified tools.",
};

export default function TutorialsPage() {
	const groups = Array.from(new Set(tutorials.map((tutorial) => tutorial.group)));

	return (
		<main className="min-h-screen w-full bg-black px-5 pb-24 pt-28 text-neutral-50 md:px-10">
			<div className="mx-auto max-w-7xl">
				<header className="max-w-4xl">
					<div className="text-sm font-semibold uppercase tracking-[0.22em] text-cyan-300">Zvibe Editor learning path</div>
					<h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-7xl">Developer tutorials</h1>
					<p className="mt-6 text-lg leading-8 tracking-normal text-neutral-300 md:text-xl">
						Build real games with the complete IDE: scene composition, assets, animation, scripting, physics, rendering, profiling, publishing, and MCP-driven
						automation.
					</p>
				</header>

				<img src="/documentation/tutorials/ide-overview.png" alt="Zvibe Editor project workspace" className="mt-10 w-full rounded-2xl border border-neutral-800" />

				<div className="mt-16 flex flex-col gap-16">
					{groups.map((group) => (
						<section key={group}>
							<div className="mb-7 max-w-3xl">
								<h2 className="text-3xl font-semibold tracking-tight">{group}</h2>
								<p className="mt-2 leading-7 tracking-normal text-neutral-400">{groupDescriptions[group]}</p>
							</div>

							<div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
								{tutorials
									.filter((tutorial) => tutorial.group === group)
									.map((tutorial, tutorialIndex) => (
										<Link
											key={tutorial.slug}
											href={`/documentation/tutorials/${tutorial.slug}`}
											className="group flex min-h-64 flex-col rounded-2xl border border-neutral-800 bg-neutral-950 p-6 transition hover:-translate-y-1 hover:border-cyan-500"
										>
											<div className="text-xs font-semibold uppercase tracking-widest text-cyan-300">Lesson {tutorialIndex + 1}</div>
											<h3 className="mt-4 text-2xl font-semibold tracking-tight group-hover:text-cyan-100">{tutorial.title}</h3>
											<p className="mt-3 flex-1 text-sm leading-6 tracking-normal text-neutral-400">{tutorial.summary}</p>
											<div className="mt-6 flex items-center justify-between text-sm text-neutral-500">
												<span>{tutorial.level}</span>
												<span>{tutorial.duration} →</span>
											</div>
										</Link>
									))}
							</div>
						</section>
					))}
				</div>
			</div>
		</main>
	);
}
