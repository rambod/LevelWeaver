export class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state * 1664525 + 1013904223) >>> 0
    return this.state / 0x100000000
  }

  nextInt(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  nextFloat(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  nextBool(probability = 0.5): boolean {
    return this.next() < probability
  }

  shuffle<T>(array: T[]): T[] {
    const result = [...array]
    for (let i = result.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i)
      ;[result[i], result[j]] = [result[j], result[i]]
    }
    return result
  }

  pick<T>(array: T[]): T {
    return array[this.nextInt(0, array.length - 1)]
  }

  getState(): number {
    return this.state
  }

  /**
   * Lawbook §8.1: hierarchical deterministic streams. Derives an
   * independent sub-seed from (root state, stage label) so a harmless
   * change to decoration RNG can never reshuffle room topology.
   */
  derive(label: string): SeededRandom {
    // Mix current state with the label hash (xmur3-style finalizer),
    // then advance this stream so sibling derives differ in order.
    let h = (this.state ^ hashString(label)) >>> 0
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0
    h = (h ^ (h >>> 16)) >>> 0
    this.next()
    return new SeededRandom(h)
  }

  setState(state: number): void {
    this.state = state >>> 0
  }
}

export function createRandom(seed: number): SeededRandom {
  return new SeededRandom(seed)
}

export function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash |= 0
  }
  return Math.abs(hash)
}