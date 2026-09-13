// Select before importing the normal graph, which repairs DBs and starts background services.
import { selectServerEntry } from './services/system/task901-maintenance-entry';
await selectServerEntry(process.env.RAPITAS_TASK901_MAINTENANCE, {
  normal: () => import('./index'),
  maintenance: () => import('./services/system/task901-maintenance-server'),
});
