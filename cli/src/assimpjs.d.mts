declare module "assimpjs" {
	const factory: (options?: { locateFile?: (file: string) => string }) => Promise<any>;
	export default factory;
}
