import { Card } from '../../ui/index.js';
import type { Screen } from '../registry.js';

function Home() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Today">
        <p className="text-base text-slate-700">Batches and logbooks appear here as they are built (R1 wave 4 and R2).</p>
      </Card>
      <Card title="This system">
        <p className="text-base text-slate-700">Every entry is saved on the server at once, with your name and the server time. Nothing is kept on this device.</p>
      </Card>
    </div>
  );
}
export const screen: Screen = { id: 'home', title: 'Home', order: 0, permission: 'session', Component: Home };
