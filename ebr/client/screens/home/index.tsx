import { useT } from '../../i18n/index.js';
import { Card } from '../../ui/index.js';
import type { Screen } from '../registry.js';

function Home() {
  const t = useT();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title={t('Today')}>
        <p className="text-base text-slate-700">{t('Open Batches to run a batch step by step, Logbooks for equipment and rooms.')}</p>
      </Card>
      <Card title={t('This system')}>
        <p className="text-base text-slate-700">{t('Every entry is saved on the server at once, with your name and the server time. Nothing is kept on this device.')}</p>
      </Card>
    </div>
  );
}
export const screen: Screen = { id: 'home', title: 'Home', order: 0, permission: 'session', Component: Home };
