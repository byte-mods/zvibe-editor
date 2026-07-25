declare module "hyphen/*" {
	export interface IHyphenationOptions {
		exceptions?: string[];
		hyphenChar?: string;
		minWordLength?: number;
	}

	export function hyphenateSync(text: string, options?: IHyphenationOptions): string;
}
