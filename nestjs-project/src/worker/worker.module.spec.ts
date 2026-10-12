import { WorkerModule } from './worker.module';
import { WorkerAppModule } from './worker-app.module';

describe('Worker modules', () => {
  it('WorkerModule and WorkerAppModule should be defined', () => {
    expect(WorkerModule).toBeDefined();
    expect(WorkerAppModule).toBeDefined();
  });
});
