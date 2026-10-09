/**
 * 假的 RTCPeerConnection，给测试用。
 *
 * 它不只是「记录调用」—— 会真的把 SDP 在两端之间传一遍、真的把数据通道接起来。
 * 所以跑在上面的是完整的邀请 → 回执 → 接通流程，协议层面的错抓得到。
 *
 * 假的只有浏览器那一层；WebRtcTransport、信令打包、RoomController 全是真代码。
 */

let seq = 0;
export const sessionHost = new Map();     // 会话号 -> 房主那端的 pc
export const sessionClient = new Map();   // 会话号 -> 加入端那端的 pc

export function resetRtc(){
  seq = 0;
  sessionHost.clear();
  sessionClient.clear();
}

class FakeDataChannel {
  constructor(label){
    this.label = label;
    this.readyState = 'connecting';
    this.onopen = this.onmessage = this.onclose = null;
    this._peer = null;
    this.sent = [];
  }
  send(data){
    this.sent.push(data);
    const peer = this._peer;
    if (peer && peer.readyState === 'open'){
      // 真实的数据通道也是异步投递的
      queueMicrotask(() => { if (peer.onmessage) peer.onmessage({ data }); });
    }
  }
  close(){
    this.readyState = 'closed';
    if (this._peer) this._peer.readyState = 'closed';
    if (this.onclose) this.onclose();
  }
  _open(){ this.readyState = 'open'; if (this.onopen) this.onopen(); }
}

export class FakePeerConnection {
  constructor(config){
    this.config = config;
    this.localDescription = null;
    this.remoteDescription = null;
    this.iceGatheringState = 'new';
    this._listeners = {};
    this._dc = null;
    this.ondatachannel = null;
    this.closed = false;
    /** 测试用：让收集永远停在半路，验证超时兜底 */
    this.neverGather = false;
  }

  addEventListener(type, fn){ (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener(type, fn){
    if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter(f => f !== fn);
  }
  createDataChannel(label){ this._dc = new FakeDataChannel(label); return this._dc; }

  async createOffer(){
    this._session = 'S' + (++seq);
    sessionHost.set(this._session, this);
    return { type:'offer', sdp:'OFFER:' + this._session };
  }
  async createAnswer(){ return { type:'answer', sdp:'ANSWER:' + this._session }; }

  async setLocalDescription(desc){
    this.localDescription = desc;
    await Promise.resolve();
    if (this.neverGather) return;
    this._finishGathering();
  }
  _finishGathering(){
    this.iceGatheringState = 'complete';
    for (const fn of this._listeners.icegatheringstatechange || []) fn();
  }

  async setRemoteDescription(desc){
    this.remoteDescription = desc;
    const sid = String(desc.sdp).split(':')[1];
    if (String(desc.sdp).startsWith('OFFER:')){
      this._session = sid;
      sessionClient.set(sid, this);            // 加入端这头
    } else if (String(desc.sdp).startsWith('ANSWER:')){
      connect(sessionHost.get(sid), sessionClient.get(sid));
    }
  }

  close(){ this.closed = true; if (this._dc) this._dc.close(); }
}

/** 两端 SDP 都换完了，把数据通道真的接起来 */
function connect(hostPc, clientPc){
  const dc = hostPc._dc;
  const mirror = new FakeDataChannel(dc.label);
  dc._peer = mirror;
  mirror._peer = dc;
  clientPc._mirror = mirror;
  if (clientPc.ondatachannel) clientPc.ondatachannel({ channel: mirror });
  setTimeout(() => { dc._open(); mirror._open(); }, 0);
}
