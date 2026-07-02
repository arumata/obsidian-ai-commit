import esbuild from 'esbuild';
import process from 'process';

const prod = process.argv[2] === 'production';

const context = await esbuild.context({
    entryPoints: ['main.ts'],
    bundle: true,
    external: ['obsidian', 'electron', 'child_process'],
    format: 'cjs',
    target: 'ES2022',
    logLevel: 'info',
    sourcemap: prod ? false : 'inline',
    treeShaking: true,
    outfile: 'main.js',
    platform: 'node',
});

if (prod) {
    await context.rebuild();
    process.exit(0);
} else {
    await context.watch();
}
