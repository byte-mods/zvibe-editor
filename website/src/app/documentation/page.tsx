"use client";

import Link from "next/link";

import { Fade } from "react-awesome-reveal";

import { NextChapterComponent } from "./next-chapter";

export default function DocumentationPage() {
	return (
		<main className="w-full min-h-screen p-5 bg-black text-neutral-50">
			<div className="flex flex-col gap-10 lg:max-w-3xl 2xl:max-w-6xl mx-auto pt-32">
				<Fade cascade damping={0.1} triggerOnce className="w-full">
					<Fade>
						<div className="text-3xl md:text-5xl lg:text-6xl font-semibold font-sans tracking-tighter text-center">Zvibe Editor developer documentation</div>
					</Fade>
				</Fade>

				<Fade triggerOnce>
					<div className="flex flex-col gap-4">
						<div className="text-3xl md:text-2xl lg:text-3xl my-3">Introduction</div>

						<div>
							Zvibe Editor is a complete visual development environment built on Babylon.js. It combines scene and asset authoring, animation, scripting, physics,
							rendering, profiling, builds, and MCP automation.
							<br />
							The Babylon.js Editor is available on <b>Window</b>, <b>macOS</b>, and <b>Linux</b> platforms.
						</div>

						<div>
							Use the guided learning path for real editor screenshots, complete workflow steps, TypeScript examples, three game projects, build instructions, and
							safe Codex or Claude-compatible MCP automation.
						</div>

						<Link
							href="/documentation/tutorials"
							className="flex items-center justify-between rounded-2xl border border-cyan-800 bg-cyan-950/30 p-6 text-cyan-100 transition hover:border-cyan-400 hover:bg-cyan-950/50"
						>
							<span>
								<span className="block text-xl font-semibold">Start the developer tutorials</span>
								<span className="mt-2 block text-sm text-cyan-200/80">IDE tour → systems → complete games → MCP</span>
							</span>
							<span className="text-2xl">→</span>
						</Link>

						<div>
							Zvibe Editor is based on the open-source Babylon.js Editor codebase. You can find the upstream project on{" "}
							<b>
								<Link target="_blank" href="https://github.com/BabylonJS/Editor" className="underline underline-offset-4">
									GitHub
								</Link>
							</b>
							.
						</div>

						<div className="text-3xl md:text-2xl lg:text-3xl my-3">Prerequisite</div>

						<div>
							<b>
								<Link target="_blank" href="https://nodejs.org" className="underline underline-offset-4">
									Node.JS
								</Link>
							</b>{" "}
							must be installed on your computer. It is recommanded to have LTS version installed <b>{">="} 20</b>
						</div>

						<div>
							By default, projects are based on <b>Next.JS</b>. It is highly recommanded to have a basic understanding of{" "}
							<b>
								<Link target="_blank" href="https://react.dev/" className="underline underline-offset-4">
									React
								</Link>
							</b>{" "}
							and{" "}
							<b>
								<Link target="_blank" href="https://nextjs.org" className="underline underline-offset-4">
									Next.JS
								</Link>
							</b>{" "}
							before starting.
						</div>

						<div>
							Of course, a basic understanding of the{" "}
							<b>
								<Link target="_blank" href="https://babylonjs.com/" className="underline underline-offset-4">
									Babylon.js
								</Link>
							</b>{" "}
							engine. The most powerful, beautiful, simple, and open web rendering engine in the world.
						</div>

						<NextChapterComponent href="/documentation/basics/creating-project" title="Creating project" />
					</div>
				</Fade>
			</div>
		</main>
	);
}
