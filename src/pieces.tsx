type PieceProps = { code: string };

const frost = {
  whiteFill: "#F5F5F5",
  whiteStroke: "#7EA8B8",
  blackFill: "#1A1F22",
  blackStroke: "#9EC9D9",
};

function tone(code: string) {
  const white = code.startsWith("w");
  return {
    fill: white ? frost.whiteFill : frost.blackFill,
    stroke: white ? frost.whiteStroke : frost.blackStroke,
  };
}

export function ChessPiece({ code }: PieceProps) {
  const t = tone(code);
  const role = code[1];
  return (
    <svg viewBox="0 0 40 40" className="piece-svg" aria-hidden>
      {role === "P" && <Pawn {...t} />}
      {role === "N" && <Knight {...t} />}
      {role === "B" && <Bishop {...t} />}
      {role === "R" && <Rook {...t} />}
      {role === "Q" && <Queen {...t} />}
      {role === "K" && <King {...t} />}
    </svg>
  );
}

function Pawn({ fill, stroke }: { fill: string; stroke: string }) {
  return (
    <g fill={fill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round">
      <circle cx="20" cy="13" r="5.2" />
      <path d="M12 33h16l-2.2-8.5c-1.6-2.2-4-3.4-7.8-3.4s-6.2 1.2-7.8 3.4Z" />
    </g>
  );
}

function Knight({ fill, stroke }: { fill: string; stroke: string }) {
  return (
    <g fill={fill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round">
      <path d="M11 33h18l-1.4-6.2c.2-6.4-3.2-9.2-6.4-12.4 2.4-.4 4.6-2.2 5.4-4.6-3.8.4-6.6-.2-8.8-2.6-2.2 3.2-5.6 5.6-6.2 10.2-.4 3.2.6 8.4-1.6 15.6Z" />
      <circle cx="16.4" cy="14.6" r="1.1" fill={stroke} stroke="none" />
    </g>
  );
}

function Bishop({ fill, stroke }: { fill: string; stroke: string }) {
  return (
    <g fill={fill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round">
      <circle cx="20" cy="8.4" r="2.1" />
      <path d="M20 11.2c-4.8 5.4-8.4 11.2-8.4 16.2 0 2.2 8.4 2.2 8.4 2.2s8.4 0 8.4-2.2c0-5-3.6-10.8-8.4-16.2Z" />
      <path d="M12 33h16" strokeLinecap="round" />
      <path d="M18.4 18.5h3.2" strokeLinecap="round" />
    </g>
  );
}

function Rook({ fill, stroke }: { fill: string; stroke: string }) {
  return (
    <g fill={fill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round">
      <path d="M10 33h20v-3.2H10Z" />
      <path d="M13 29.8h14l-.8-10.4H13.8Z" />
      <path d="M12.4 19.4h15.2V13l-3.2.1V10h-2.6v3h-3.6v-3h-2.6v3H12.4Z" />
    </g>
  );
}

function Queen({ fill, stroke }: { fill: string; stroke: string }) {
  return (
    <g fill={fill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round">
      <circle cx="20" cy="7.2" r="1.7" />
      <circle cx="9.6" cy="11.4" r="1.5" />
      <circle cx="30.4" cy="11.4" r="1.5" />
      <circle cx="14.2" cy="8.6" r="1.4" />
      <circle cx="25.8" cy="8.6" r="1.4" />
      <path d="M10.2 13.2 13 24.6h14l2.8-11.4-4.8 6.2-2.8-8.4L20 20.2l-2.2-6.6-2.8 8.4Z" />
      <path d="M12.4 28.4h15.2L29 33H11Z" />
    </g>
  );
}

function King({ fill, stroke }: { fill: string; stroke: string }) {
  return (
    <g fill={fill} stroke={stroke} strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round">
      <path d="M20 6.4v7.2" />
      <path d="M16.8 10h6.4" />
      <path d="M11.2 33h17.6l-1.4-6.2c2.6-2.8 4-6.2 4-9.6 0-4.4-4.8-7.2-11.4-7.2S8.6 12.8 8.6 17.2c0 3.4 1.4 6.8 4 9.6Z" />
    </g>
  );
}
