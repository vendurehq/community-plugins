import path from 'path';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['bench/perf/**/*.test.ts'],
        exclude: ['e2e/**', 'node_modules/**', 'lib/**'],
        fileParallelism: false,
        testTimeout: 30 * 60 * 1000,
        typecheck: {
            tsconfig: path.resolve(__dirname, '../../../../e2e-common/tsconfig.e2e.json'),
        },
        allowOnly: true,
    },
    plugins: [
        swc.vite({
            jsc: { transform: { useDefineForClassFields: false } },
        }),
    ],
});
