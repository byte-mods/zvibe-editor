import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getTutorial, tutorials } from "../tutorial-data";
import { TutorialPage } from "../tutorial-page";

export function generateStaticParams() {
	return tutorials.map((tutorial) => ({ slug: tutorial.slug }));
}

export async function generateMetadata(props: { params: Promise<{ slug: string }> }): Promise<Metadata> {
	const { slug } = await props.params;
	const tutorial = getTutorial(slug);

	return tutorial ? { title: `${tutorial.title} | Zvibe Editor`, description: tutorial.summary } : {};
}

export default async function TutorialRoute(props: { params: Promise<{ slug: string }> }) {
	const { slug } = await props.params;
	const tutorial = getTutorial(slug);

	if (!tutorial) {
		notFound();
	}

	return <TutorialPage tutorial={tutorial} />;
}
