const tailwind = require('@tailwindcss/postcss');

const stripWebkitTextSizeAdjust = () => ({
  postcssPlugin: 'strip-webkit-text-size-adjust',
  Once(root) {
    root.walkDecls('-webkit-text-size-adjust', (declaration) => {
      if (declaration.value === '100%') {
        declaration.remove();
      }
    });
  },
});

stripWebkitTextSizeAdjust.postcss = true;

module.exports = {
  plugins: [tailwind(), stripWebkitTextSizeAdjust()],
};
