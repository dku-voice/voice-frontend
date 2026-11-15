module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['react', 'react-hooks'],
  extends: ['eslint:recommended'],
  rules: {
    'react/jsx-uses-react': 'error',
    'react/jsx-uses-vars': 'error',
    'react-hooks/rules-of-hooks': 'error',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  ignorePatterns: ['dist/', 'build/', 'node_modules/'],
  overrides: [
    { files: ['public/pcm-capture-processor.js'], rules: { 'no-redeclare': ['error', { builtinGlobals: false }] } },
    { files: ['*.config.js', '*.cjs', 'tests/**/*.js', 'src/App.test.js'], env: { node: true } },
  ],
};
