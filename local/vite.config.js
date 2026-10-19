export default {
  server: {
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.AGORA_API_PORT || '8787'}`, ws: true },
    },
  },
};
