import { app } from './app.js';

const port = Number(process.env.PORT ?? 3000);

app.listen(port, () => {
  console.log(`IndoSync Phase 1 listening on http://localhost:${port}`);
});
