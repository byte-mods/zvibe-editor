import Link from "next/link";

import { CodeBlock } from "../code";
import { ITutorial, ITutorialSection, tutorials } from "./tutorial-data";

function RichText(props: { text: string }) {
	const fragments = props.text.split(/(`[^`]+`)/g);

	return (
		<>
			{fragments.map((fragment, index) =>
				fragment.startsWith("`") && fragment.endsWith("`") ? (
					<code key={`${fragment}-${index}`} className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[0.9em] text-cyan-200">
						{fragment.slice(1, -1)}
					</code>
				) : (
					<span key={`${fragment}-${index}`}>{fragment}</span>
				)
			)}
		</>
	);
}

function TutorialSection(props: { section: ITutorialSection; index: number }) {
	const section = props.section;

	return (
		<section id={section.id} className="scroll-mt-28 border-t border-neutral-800 pt-10">
			<div className="mb-5 flex items-start gap-4">
				<div className="flex h-8 min-w-8 items-center justify-center rounded-full bg-cyan-300 text-sm font-bold text-black">{props.index + 1}</div>
				<h2 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">{section.title}</h2>
			</div>

			<div className="flex flex-col gap-5 text-base leading-7 tracking-normal text-neutral-300">
				{section.paragraphs?.map((paragraph) => (
					<p key={paragraph}>
						<RichText text={paragraph} />
					</p>
				))}

				{section.steps && (
					<ol className="ml-5 list-decimal space-y-3 marker:font-semibold marker:text-cyan-300">
						{section.steps.map((step) => (
							<li key={step} className="pl-2">
								<RichText text={step} />
							</li>
						))}
					</ol>
				)}

				{section.bullets && (
					<ul className="ml-5 list-disc space-y-3 marker:text-cyan-300">
						{section.bullets.map((bullet) => (
							<li key={bullet} className="pl-2">
								<RichText text={bullet} />
							</li>
						))}
					</ul>
				)}

				{section.table && (
					<div className="overflow-x-auto rounded-xl border border-neutral-800">
						<table className="w-full min-w-[640px] border-collapse text-left text-sm">
							<thead className="bg-neutral-900 text-neutral-100">
								<tr>
									{section.table.headers.map((header) => (
										<th key={header} className="border-b border-neutral-800 px-4 py-3 font-semibold">
											{header}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{section.table.rows.map((row) => (
									<tr key={row.join("-")} className="border-b border-neutral-900 last:border-0">
										{row.map((cell, cellIndex) => (
											<td key={`${cell}-${cellIndex}`} className={`px-4 py-3 align-top ${cellIndex === 0 ? "font-medium text-white" : ""}`}>
												<RichText text={cell} />
											</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				{section.figure && (
					<figure className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950">
						<img src={section.figure.src} alt={section.figure.alt} className="h-auto w-full" loading="lazy" />
						<figcaption className="border-t border-neutral-800 px-4 py-3 text-sm text-neutral-400">{section.figure.caption}</figcaption>
					</figure>
				)}

				{section.code && (
					<div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-4">
						<div className="mb-3 text-sm font-semibold text-neutral-200">{section.code.title}</div>
						<CodeBlock code={section.code.code} language={section.code.language} />
					</div>
				)}

				{section.note && (
					<div className="rounded-xl border border-cyan-800/70 bg-cyan-950/30 px-5 py-4 text-cyan-100">
						<span className="font-semibold">Note: </span>
						<RichText text={section.note} />
					</div>
				)}

				{section.warning && (
					<div className="rounded-xl border border-amber-700/70 bg-amber-950/30 px-5 py-4 text-amber-100">
						<span className="font-semibold">Watch out: </span>
						<RichText text={section.warning} />
					</div>
				)}
			</div>
		</section>
	);
}

export function TutorialPage(props: { tutorial: ITutorial }) {
	const index = tutorials.findIndex((candidate) => candidate.slug === props.tutorial.slug);
	const previous = index > 0 ? tutorials[index - 1] : undefined;
	const next = index < tutorials.length - 1 ? tutorials[index + 1] : undefined;

	return (
		<main className="min-h-screen w-full bg-black px-5 pb-24 pt-28 text-neutral-50 md:px-10">
			<div className="mx-auto grid max-w-7xl gap-12 xl:grid-cols-[minmax(0,1fr)_260px]">
				<article className="min-w-0">
					<Link href="/documentation/tutorials" className="text-sm font-medium text-cyan-300 hover:text-cyan-100">
						← Developer tutorials
					</Link>

					<header className="mb-12 mt-6">
						<div className="mb-4 text-sm font-semibold uppercase tracking-[0.22em] text-cyan-300">{props.tutorial.group}</div>
						<h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-white md:text-6xl">{props.tutorial.title}</h1>
						<p className="mt-5 max-w-3xl text-lg leading-8 tracking-normal text-neutral-300">{props.tutorial.summary}</p>

						<div className="mt-7 flex flex-wrap gap-3 text-sm">
							<span className="rounded-full border border-neutral-700 px-3 py-1.5">{props.tutorial.level}</span>
							<span className="rounded-full border border-neutral-700 px-3 py-1.5">{props.tutorial.duration}</span>
						</div>
					</header>

					<div className="mb-12 grid gap-4 md:grid-cols-2">
						<div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6">
							<h2 className="mb-4 text-lg font-semibold">Before you start</h2>
							<ul className="ml-5 list-disc space-y-2 text-sm leading-6 tracking-normal text-neutral-300 marker:text-cyan-300">
								{props.tutorial.prerequisites.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</div>
						<div className="rounded-2xl border border-neutral-800 bg-neutral-950 p-6">
							<h2 className="mb-4 text-lg font-semibold">You will be able to</h2>
							<ul className="ml-5 list-disc space-y-2 text-sm leading-6 tracking-normal text-neutral-300 marker:text-cyan-300">
								{props.tutorial.outcomes.map((item) => (
									<li key={item}>{item}</li>
								))}
							</ul>
						</div>
					</div>

					<div className="flex flex-col gap-12">
						{props.tutorial.sections.map((section, sectionIndex) => (
							<TutorialSection key={section.id} section={section} index={sectionIndex} />
						))}
					</div>

					<nav className="mt-16 grid gap-4 border-t border-neutral-800 pt-8 sm:grid-cols-2">
						{previous ? (
							<Link
								href={`/documentation/tutorials/${previous.slug}`}
								className="rounded-xl border border-neutral-800 p-5 transition hover:border-cyan-500 hover:bg-neutral-950"
							>
								<div className="text-xs uppercase tracking-widest text-neutral-500">Previous</div>
								<div className="mt-2 font-semibold">← {previous.title}</div>
							</Link>
						) : (
							<div />
						)}
						{next && (
							<Link
								href={`/documentation/tutorials/${next.slug}`}
								className="rounded-xl border border-neutral-800 p-5 text-right transition hover:border-cyan-500 hover:bg-neutral-950"
							>
								<div className="text-xs uppercase tracking-widest text-neutral-500">Next</div>
								<div className="mt-2 font-semibold">{next.title} →</div>
							</Link>
						)}
					</nav>
				</article>

				<aside className="hidden xl:block">
					<div className="sticky top-28 rounded-2xl border border-neutral-800 bg-neutral-950 p-5">
						<div className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">On this page</div>
						<nav className="flex flex-col gap-3 text-sm leading-5 tracking-normal">
							{props.tutorial.sections.map((section, sectionIndex) => (
								<a key={section.id} href={`#${section.id}`} className="text-neutral-400 transition hover:text-cyan-300">
									{sectionIndex + 1}. {section.title}
								</a>
							))}
						</nav>
					</div>
				</aside>
			</div>
		</main>
	);
}
