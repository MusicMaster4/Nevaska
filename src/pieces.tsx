import { defaultPieces } from "react-chessboard";

export function ChessPiece({ code }: { code: string }) {
  const Piece = defaultPieces[code];
  return Piece ? <Piece /> : null;
}
