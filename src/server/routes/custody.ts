// Domain: sample receipt, chain of custody, storage, aliquots, retains and labels (roadmap M29). Owned by r2-custody-labels;
// registered in src/server/routes/index.ts and given its rules in src/server/authz/routeTable.ts by the wave gate. The rules are in
// src/server/custody/service.ts.
//
//   GET  /custody/samples/:id                         status, receipt, containers, ledger, retains, label prints          custody.view
//   POST /custody/samples/:id/receipt                 record the receipt; makes the primary container                    custody.handle
//   POST /custody/samples/:id/receipt/acknowledge     QA accepts a receipt deviation: e-signed (CUSTODY_DEVIATION_ACK)   custody.approve
//   POST /custody/containers/:id/aliquots             a child container out of this one                                  custody.handle
//   POST /custody/containers/:id/consume              a quantity used for testing                                        custody.handle
//   POST /custody/containers/:id/transfer             a new location and/or holder                                       custody.handle
//   POST /custody/containers/:id/retain               into the retain register until a date                              custody.handle
//   GET  /custody/retains                             the retain register (?due=true: disposal due)                      custody.view
//   POST /custody/retains/:id/dispose                 signed disposal (RETAIN_DISPOSAL), once the date has come          custody.approve
//   GET  /custody/locations                           the storage location tree                                          custody.view
//   POST /custody/locations                           define a location                                                  custody.locations
//   PUT  /custody/locations/:id                       rename, temperature range, deactivate                              custody.locations
//   POST /custody/labels                              print a label (a reprint needs a reason); logged                   label.print
//   GET  /custody/labels                              the label log                                                      custody.view
//   GET  /custody/verify                              recompute the ledger and label-log chains                          record.verify
import { type RouteContext } from '../core/context';
import { createRouter } from '../core/router';
import { validate } from '../http/validate';
import {
  aliquotSchema, consumeSchema, disposeSchema, labelPrintSchema, labelQuerySchema, locationCreateSchema, locationUpdateSchema, receiptAckSchema,
  receiptSchema, retainQuerySchema, retainSchema, transferSchema,
} from '../custody/schemas';
import {
  acknowledgeDeviation, consume, createLocation, disposeRetain, getSampleCustody, listLabelPrints, listLocations, listRetains, makeAliquot,
  printLabel, recordReceipt, registerRetain, transfer, updateLocation, verifyCustody, type Actor,
} from '../custody/service';

const signatureView = (signature: { signerName: string }, user: { email?: string }) => ({ ...signature, printedName: signature.signerName, signerEmail: user.email });

export const custodyRoutes = ({ db, requireAuth }: RouteContext) => {
  const router = createRouter();
  const actor = (req: any) => req.user as Actor & { email?: string };
  const id = (req: any) => String(req.params.id);

  router.get('/custody/samples/:id', requireAuth, async (req, res) => {
    res.json(await getSampleCustody(db, id(req)));
  });

  router.post('/custody/samples/:id/receipt', requireAuth, validate(receiptSchema), async (req, res) => {
    res.json(await recordReceipt(db, actor(req), id(req), req.body));
  });

  router.post('/custody/samples/:id/receipt/acknowledge', requireAuth, validate(receiptAckSchema), async (req, res) => {
    const user = actor(req);
    const { result, signature } = await acknowledgeDeviation(db, req, user, id(req), req.body);
    res.json({ receipt: result, signature: signatureView(signature, user) });
  });

  router.post('/custody/containers/:id/aliquots', requireAuth, validate(aliquotSchema), async (req, res) => {
    res.json(await makeAliquot(db, actor(req), id(req), req.body));
  });

  router.post('/custody/containers/:id/consume', requireAuth, validate(consumeSchema), async (req, res) => {
    res.json(await consume(db, actor(req), id(req), req.body));
  });

  router.post('/custody/containers/:id/transfer', requireAuth, validate(transferSchema), async (req, res) => {
    res.json(await transfer(db, actor(req), id(req), req.body));
  });

  router.post('/custody/containers/:id/retain', requireAuth, validate(retainSchema), async (req, res) => {
    res.json(await registerRetain(db, actor(req), id(req), req.body));
  });

  router.get('/custody/retains', requireAuth, validate(retainQuerySchema, 'query'), async (req, res) => {
    res.json(await listRetains(db, req.query as any));
  });

  router.post('/custody/retains/:id/dispose', requireAuth, validate(disposeSchema), async (req, res) => {
    const user = actor(req);
    const { result, signature } = await disposeRetain(db, req, user, id(req), req.body);
    res.json({ ...result, signature: signatureView(signature, user) });
  });

  router.get('/custody/locations', requireAuth, async (_req, res) => {
    res.json(await listLocations(db));
  });

  router.post('/custody/locations', requireAuth, validate(locationCreateSchema), async (req, res) => {
    res.json(await createLocation(db, actor(req), req.body));
  });

  router.put('/custody/locations/:id', requireAuth, validate(locationUpdateSchema), async (req, res) => {
    res.json(await updateLocation(db, actor(req), id(req), req.body));
  });

  router.post('/custody/labels', requireAuth, validate(labelPrintSchema), async (req, res) => {
    res.json(await printLabel(db, actor(req), req.body));
  });

  router.get('/custody/labels', requireAuth, validate(labelQuerySchema, 'query'), async (req, res) => {
    res.json(await listLabelPrints(db, req.query as any));
  });

  router.get('/custody/verify', requireAuth, async (_req, res) => {
    res.json(await verifyCustody(db));
  });

  return router;
};
