import { describe, expect, it } from 'vitest'

import {
  createBoard,
  dropDisc,
  getAvailableColumns,
  getWinner,
  getWinningLine,
  serializeBoard,
} from './connect-four'

function play(columns: number[]) {
  let board = createBoard()

  columns.forEach((column, index) => {
    board = dropDisc(board, column, index % 2 === 0 ? 'red' : 'yellow').board
  })

  return board
}

describe('connect-four domain', () => {
  it('stacks discs from the bottom without mutating the original board', () => {
    const initial = createBoard()
    const first = dropDisc(initial, 3, 'red')
    const second = dropDisc(first.board, 3, 'yellow')

    expect(initial[5]?.[3]).toBeNull()
    expect(first.position).toEqual({ column: 3, row: 5 })
    expect(second.position).toEqual({ column: 3, row: 4 })
  })

  it('detects horizontal, vertical, and diagonal wins', () => {
    const horizontal = play([0, 0, 1, 1, 2, 2, 3])
    const vertical = play([0, 1, 0, 1, 0, 1, 0])
    const diagonal = play([0, 1, 1, 2, 4, 2, 2, 3, 4, 3, 4, 3, 3])

    expect(getWinner(horizontal)).toBe('red')
    expect(getWinner(vertical)).toBe('red')
    expect(getWinner(diagonal)).toBe('red')
    expect(getWinningLine(diagonal)).toHaveLength(4)
  })

  it('excludes full columns from the legal moves', () => {
    let board = createBoard()
    for (let turn = 0; turn < 6; turn += 1)
      board = dropDisc(board, 2, turn % 2 === 0 ? 'red' : 'yellow').board

    expect(getAvailableColumns(board)).not.toContain(2)
    expect(() => dropDisc(board, 2, 'red')).toThrow('full')
  })

  it('serializes the visual board from top to bottom', () => {
    const board = play([0, 1, 0])

    expect(serializeBoard(board).split('\n').slice(-2)).toEqual([
      '|R|.|.|.|.|.|.|',
      '|R|Y|.|.|.|.|.|',
    ])
  })
})
