import { Command, decodeMessage, encodeCreate, encodeDestroy } from './protocol.js';
import { InventoryState } from './inventory-state.js';

export class InventoryConnection {
  constructor(onChange, { WebSocketClass = globalThis.WebSocket, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
    this.onChange = onChange;
    this.WebSocketClass = WebSocketClass;
    // Browser timer APIs require Window as their receiver, even when stored here.
    this.setTimer = setTimer.bind(globalThis);
    this.clearTimer = clearTimer.bind(globalThis);
    this.inventory = new InventoryState();
    this.socket = null;
    this.timer = null;
    this.status = 'Disconnected';
    this.message = '';
    this.nextRequestId = 1;
    this.pendingCreate = null;
    this.createTimer = null;
    this.creation = null;
    this.pendingDelete = null;
    this.deleteTimer = null;
    this.deletion = null;
  }

  get canCreate() {
    return this.inventory.ready && this.socket?.readyState === 1 && !this.pendingDelete && this.nextRequestId <= 0xffffffff;
  }

  get canMutate() {
    return this.canCreate && !this.pendingCreate;
  }

  delete(highIds, label) {
    if (!this.canMutate || !highIds.length || !highIds.every(id => this.inventory.items.has(id))) throw new Error('Deletion requires a synchronized connection, existing items, and no pending request.');
    const bytes = new Blob(highIds.map(id => encodeDestroy(id)));
    const pending = { highIds: new Set(highIds), label: highIds.length === 1 ? `${label}: item ${highIds[0]}` : label };
    this.pendingDelete = pending;
    this.deletion = { ...pending, status: 'pending', message: `Deleting ${pending.label}…` };
    try { this.socket.send(bytes); }
    catch (error) {
      this.pendingDelete = null;
      this.deletion = { ...pending, status: 'failed', message: `Delete send failed: ${error.message}` };
      this.onChange(this);
      return;
    }
    this.deleteTimer = this.setTimer(() => {
      if (this.pendingDelete !== pending) return;
      this.deleteTimer = null;
      this.deletion = { ...pending, status: 'uncertain', message: `Deletion of ${pending.label} is unconfirmed. Wait or reconnect to inspect the fresh inventory.` };
      this.onChange(this);
    }, 10000);
    this.onChange(this);
  }

  trackDeletion(commands) {
    const pending = this.pendingDelete;
    if (!pending || !commands.some(c => c.type === Command.destroy && pending.highIds.has(c.highId))) return;
    for (const id of pending.highIds) if (this.inventory.items.has(id)) return;
    this.clearTimer(this.deleteTimer);
    this.deleteTimer = null;
    this.pendingDelete = null;
    this.deletion = { ...pending, status: 'confirmed', message: `Deleted ${pending.label}.` };
  }

  create(template, label, count = 1) {
    if (!this.canCreate) throw new Error('Creation requires a synchronized open connection and no pending request.');
    const requestId = this.nextRequestId;
    const draft = structuredClone(template);
    const bytes = new Blob(Array.from({ length: count }, (_, i) => encodeCreate(draft, requestId + i)));
    this.nextRequestId += count;
    if (count > 1) label = `${count} × ${label}`;
    const pending = { requestId, count, label, assignedIds: new Set(), observedIds: new Set() };
    this.pendingCreate = pending;
    this.creation = { status: 'pending', requestId, label, message: `Creating ${label} (request ${requestId})…` };
    try {
      this.socket.send(bytes);
    } catch (error) {
      this.pendingCreate = null;
      this.creation = { status: 'failed', requestId, label, message: `Send failed: ${error.message}` };
      this.onChange(this);
      return;
    }
    this.createTimer = this.setTimer(() => {
      if (this.pendingCreate !== pending) return;
      this.createTimer = null;
      this.creation = { status: 'uncertain', requestId, label, message: `Creation of ${label} is unconfirmed. It may already exist. Wait for confirmation or reconnect and inspect the fresh inventory before creating again.` };
      this.onChange(this);
    }, 10000);
    this.onChange(this);
  }

  trackCreation(commands) {
    const pending = this.pendingCreate;
    if (!pending) return;
    for (const command of commands) {
      if (command.type === Command.setId && command.requestId >= pending.requestId && command.requestId < pending.requestId + pending.count) pending.assignedIds.add(command.highId);
      if (command.type === Command.create || command.type === Command.modify) pending.observedIds.add(command.item.highId);
    }
    if (pending.assignedIds.size < pending.count) return;
    const ids = [...pending.assignedIds];
    if (ids.every(id => pending.observedIds.has(id) && this.inventory.items.has(id))) {
      this.clearTimer(this.createTimer);
      this.createTimer = null;
      this.creation = { status: 'confirmed', requestId: pending.requestId, label: pending.label, highId: ids.at(-1), message: `Created ${pending.label}: item ${ids.at(-1)}.` };
      this.pendingCreate = null;
    }
  }

  publish(status, message = '') {
    this.status = status;
    this.message = message;
    this.onChange(this);
  }

  release() {
    this.clearTimer(this.deleteTimer);
    this.deleteTimer = null;
    if (this.pendingDelete) {
      this.deletion = { ...this.pendingDelete, status: 'unconfirmed', message: `Disconnected before confirming deletion of ${this.pendingDelete.label}. Inspect the fresh inventory after reconnecting; deletion will not be retried.` };
    }
    this.pendingDelete = null;
    if (this.deletion?.status === 'confirmed') this.deletion = null;
    this.clearTimer(this.timer);
    this.timer = null;
    this.clearTimer(this.createTimer);
    this.createTimer = null;
    if (this.pendingCreate) {
      this.creation = { status: 'unconfirmed', requestId: this.pendingCreate.requestId, label: this.pendingCreate.label, message: `Disconnected before confirming ${this.pendingCreate.label}. The item may already exist. Inspect the fresh inventory after reconnecting; this request will not be retried.` };
    }
    this.pendingCreate = null;
    if (this.creation?.status === 'confirmed') this.creation = null;
    const socket = this.socket;
    this.socket = null;
    this.inventory.reset();
    if (socket) socket.close();
  }

  disconnect() {
    this.release();
    this.publish('Disconnected');
  }

  fail(message) {
    this.release();
    this.publish('Error', message);
  }

  connect() {
    this.release();
    this.publish('Connecting');
    let socket;
    try {
      socket = new this.WebSocketClass('ws://127.0.0.1:13001');
    } catch (error) {
      this.fail(error.message);
      return;
    }
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    this.timer = this.setTimer(() => {
      if (this.socket === socket) this.fail('Timed out waiting for inventory. Check that the game is running and the editor server is enabled.');
    }, 10000);
    socket.onopen = () => {
      if (this.socket === socket) this.publish('Waiting for inventory');
    };
    socket.onmessage = event => {
      if (this.socket !== socket) return;
      try {
        const commands = decodeMessage(event.data);
        this.inventory.apply(commands);
        this.trackCreation(commands);
        this.trackDeletion(commands);
        if (this.inventory.ready && (!this.pendingCreate || commands.some(c => c.type !== Command.setId))) {
          this.clearTimer(this.timer);
          this.timer = null;
          this.publish('Connected');
        }
      } catch (error) {
        this.fail(error.message);
      }
    };
    socket.onerror = () => {
      if (this.socket === socket) this.fail('Connection failed. Check the game, inventory_editor_origin, and the browser console.');
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.release();
      this.publish('Disconnected', `GC connection closed (code ${event.code}).`);
    };
  }
}
