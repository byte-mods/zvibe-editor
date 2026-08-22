/** @type {import('next').NextConfig} */
const nextConfig = {
	reactStrictMode: false,
	distDir: process.env.BJS_EDITOR_OUTPUT_DIRECTORY || ".next",
	productionBrowserSourceMaps: process.env.BJS_EDITOR_SOURCE_MAPS === "true",

	turbopack: {
		rules: {
			"*.{fx}": {
				loaders: ["raw-loader"],
				as: "*.js",
			},
		},
	},
};

module.exports = nextConfig;
