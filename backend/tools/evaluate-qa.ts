import { connectDb, disconnectDb } from '../src/db';
import { Application } from '../src/models/Application';
import { evaluationWorkerHandler } from '../src/services/evaluationEngine';

async function run() {
  await connectDb();
  const apps = await Application.find({ 
    email: { $in: ['qa-strong@igaps-test.dev', 'qa-borderline@igaps-test.dev', 'qa-weak@igaps-test.dev'] } 
  });
  
  console.log('Found ' + apps.length + ' QA apps');
  for (const app of apps) {
    console.log('Evaluating ' + app.startupName + '...');
    try {
      await evaluationWorkerHandler({ data: { applicationId: app._id.toString() } } as any);
      console.log('Done with ' + app.startupName);
    } catch (e) {
      console.error('Failed to evaluate ' + app.startupName, e);
    }
  }
  
  await disconnectDb();
  process.exit(0);
}

run();
