import { plugin } from "bun";

/**
 * `opencut-wasm` is built with `wasm-pack --target bundler`, which imports the
 * `.wasm` file as an ES module. Next's bundler supports that; Bun's test runner
 * does not, so this preload compiles the module and re-exposes its exports.
 */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

plugin({
	name: "wasm-esm-loader",
	setup(build) {
		build.onLoad({ filter: /\.wasm$/ }, async ({ path }) => {
			const module = new WebAssembly.Module(await Bun.file(path).arrayBuffer());
			const importSources = [
				...new Set(WebAssembly.Module.imports(module).map((i) => i.module)),
			];
			const exportNames = WebAssembly.Module.exports(module)
				.map((e) => e.name)
				.filter((name) => IDENTIFIER.test(name));

			const contents = [
				...importSources.map(
					(source, index) =>
						`import * as __import${index} from ${JSON.stringify(source)};`,
				),
				`const __bytes = await Bun.file(${JSON.stringify(path)}).arrayBuffer();`,
				`const { instance } = await WebAssembly.instantiate(__bytes, {${importSources
					.map((source, index) => `${JSON.stringify(source)}: __import${index}`)
					.join(", ")}});`,
				...exportNames.map(
					(name) => `export const ${name} = instance.exports.${name};`,
				),
			].join("\n");

			return { contents, loader: "js" };
		});
	},
});
