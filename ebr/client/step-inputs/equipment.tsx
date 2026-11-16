import { useT } from '../i18n/index.js';
import { TextField } from '../ui/index.js';
import type { StepInput } from './types.js';

/** The equipment step: the code of the equipment or room (fixed by the recipe, or typed / scanned from its label). */
function Fields({ def }: { def: Record<string, unknown> }) {
  const t = useT();
  const fixed = typeof def.objectCode === 'string' && def.objectCode ? def.objectCode : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-base">{t('The server checks its logbook: it must be clean and in calibration. Its use is written into the logbook when you sign.')}</p>
      {fixed ? <p className="text-base">{t('Required:')} <b>{fixed}</b></p> : null}
      <TextField label={def.objectKind === 'room' ? t('Room code *') : t('Equipment code *')} name="objectCode" required defaultValue={fixed ?? ''} autoCapitalize="characters" dir="ltr" />
    </div>
  );
}

export const stepInput: StepInput = { type: 'equipment', Fields, read: (f) => ({ objectCode: String(f.get('objectCode') ?? '').trim() }) };
