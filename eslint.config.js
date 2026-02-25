import neostandard from 'neostandard'

export default [
  ...neostandard({
    env: ['node', 'vitest'],
    noJsx: true,
    noStyle: true
  }),
  {
    ignores: [
      'coverage/**',
      'node_modules/**',
      '.husky/**',
      'dist/**',
      'build/**',
      '*.config.js'
    ]
  }
]
