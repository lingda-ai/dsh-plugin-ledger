/**
 * 有界环形缓冲。
 *
 * 性能约束：单次写入 O(1)、无 shift、无中间数组分配。
 * 事件流是热路径，每个 session/event 都会走到这里。
 */
export class RingBuffer {
  #items
  #start = 0
  #size = 0

  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError('RingBuffer capacity must be a positive integer')
    }
    this.capacity = capacity
    this.#items = new Array(capacity)
  }

  get size() {
    return this.#size
  }

  push(item) {
    if (this.#size < this.capacity) {
      this.#items[(this.#start + this.#size) % this.capacity] = item
      this.#size += 1
      return
    }
    // 已满：覆盖最旧，头指针前移
    this.#items[this.#start] = item
    this.#start = (this.#start + 1) % this.capacity
  }

  /** 按时间顺序返回副本（调用方拿去序列化/渲染，不共享内部数组） */
  toArray() {
    const out = new Array(this.#size)
    for (let i = 0; i < this.#size; i += 1) {
      out[i] = this.#items[(this.#start + i) % this.capacity]
    }
    return out
  }

  last(n) {
    if (!Number.isInteger(n) || n <= 0) return []
    return this.toArray().slice(-n)
  }

  clear() {
    this.#items.fill(undefined)
    this.#start = 0
    this.#size = 0
  }
}
