module.exports = {
  extends: ['../.eslintrc.js'],
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
  },
  rules: {
    // Infrastructure-specific overrides can be added here
  },
};
