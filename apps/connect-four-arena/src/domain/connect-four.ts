export const BOARD_COLUMNS = 7
export const BOARD_ROWS = 6

export type PlayerId = 'red' | 'yellow'
export type Cell = PlayerId | null
export type Board = Cell[][]

export interface BoardPosition {
  column: number
  row: number
}

export interface DropResult {
  board: Board
  position: BoardPosition
}

const DIRECTIONS = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
] as const

/** Creates a top-to-bottom board representation suitable for both UI and prompt serialization. */
export function createBoard(): Board {
  return Array.from({ length: BOARD_ROWS }, () => new Array<Cell>(BOARD_COLUMNS).fill(null))
}

export function getAvailableColumns(board: Board): number[] {
  return Array.from({ length: BOARD_COLUMNS }, (_, column) => column)
    .filter(column => board[0]?.[column] === null)
}

export function dropDisc(board: Board, column: number, player: PlayerId): DropResult {
  if (!Number.isInteger(column) || column < 0 || column >= BOARD_COLUMNS)
    throw new Error(`Column ${column + 1} is outside the board.`)

  for (let row = BOARD_ROWS - 1; row >= 0; row -= 1) {
    if (board[row]?.[column] !== null)
      continue

    const nextBoard = board.map(boardRow => [...boardRow])
    nextBoard[row]![column] = player
    return {
      board: nextBoard,
      position: { column, row },
    }
  }

  throw new Error(`Column ${column + 1} is full.`)
}

/** Returns the first four-cell winning line, or an empty array when play should continue. */
export function getWinningLine(board: Board): BoardPosition[] {
  for (let row = 0; row < BOARD_ROWS; row += 1) {
    for (let column = 0; column < BOARD_COLUMNS; column += 1) {
      const player = board[row]?.[column]
      if (!player)
        continue

      for (const [rowStep, columnStep] of DIRECTIONS) {
        const line = Array.from({ length: 4 }, (_, offset) => ({
          column: column + columnStep * offset,
          row: row + rowStep * offset,
        }))

        const isInsideBoard = line.every(position =>
          position.row >= 0
          && position.row < BOARD_ROWS
          && position.column >= 0
          && position.column < BOARD_COLUMNS,
        )

        if (isInsideBoard && line.every(position => board[position.row]?.[position.column] === player))
          return line
      }
    }
  }

  return []
}

export function getWinner(board: Board): PlayerId | null {
  const firstWinningCell = getWinningLine(board)[0]
  return firstWinningCell ? board[firstWinningCell.row]?.[firstWinningCell.column] ?? null : null
}

export function isBoardFull(board: Board): boolean {
  return getAvailableColumns(board).length === 0
}

export function otherPlayer(player: PlayerId): PlayerId {
  return player === 'red' ? 'yellow' : 'red'
}

/** Serializes the board with stable symbols so every persona receives the exact same observation. */
export function serializeBoard(board: Board): string {
  const symbols: Record<PlayerId, string> = {
    red: 'R',
    yellow: 'Y',
  }

  return board
    .map(row => `|${row.map(cell => cell ? symbols[cell] : '.').join('|')}|`)
    .join('\n')
}
