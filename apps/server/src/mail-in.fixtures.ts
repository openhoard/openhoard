import { createServer, type Server, type Socket } from "node:net";

/*
 * A mailbox to test against: just enough IMAP (RFC 3501) for what mail-in.ts asks of a real
 * server through imapflow. One folder, INBOX; plain TCP on a loopback port.
 */

export interface FakeMessage {
  uid: number;
  raw: Buffer;
  flags: Set<string>;
}

export interface FakeImap {
  port: number;
  messages: FakeMessage[];
  /** Adds a message, unread; returns its UID. */
  deliver(raw: string | Buffer): number;
  /** Every command line the server was sent, without its tag. */
  commands: string[];
  /** Drops the connection when a command starts with this (once). */
  failOn: string | null;
  close(): Promise<void>;
}

export async function startFakeImap(user: string, password: string): Promise<FakeImap> {
  const sockets = new Set<Socket>();
  const fake: FakeImap = {
    port: 0,
    messages: [],
    commands: [],
    failOn: null,
    deliver(raw) {
      const uid = (fake.messages.at(-1)?.uid ?? 0) + 1;
      // CRLF line ends, as mail has on the wire.
      const text = typeof raw === "string" ? raw.replace(/\r?\n/g, "\r\n") : raw;
      fake.messages.push({ uid, raw: Buffer.from(text), flags: new Set() });
      return uid;
    },
    close: () =>
      new Promise((done) => {
        for (const s of sockets) s.destroy();
        server.close(() => done());
      }),
  };
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let authed = false;
    /** A tag waiting for the client's answer to an AUTHENTICATE PLAIN challenge. */
    let challenge: string | null = null;
    const send = (text: string) => socket.write(text);
    const select = (ids: string) => {
      const wanted = new Set<number>();
      for (const part of ids.split(",")) {
        const [a, b] = part.split(":").map(Number) as [number, number | undefined];
        for (let n = a; n <= (b ?? a); n++) wanted.add(n);
      }
      return fake.messages.filter((m) => wanted.has(m.uid));
    };
    const handle = (line: string) => {
      if (challenge !== null) {
        const tag = challenge;
        challenge = null;
        const [, u, p] = Buffer.from(line, "base64").toString().split("\0");
        authed = u === user && p === password;
        send(authed ? `${tag} OK authenticated\r\n` : `${tag} NO [AUTHENTICATIONFAILED] no\r\n`);
        return;
      }
      const space = line.indexOf(" ");
      const tag = line.slice(0, space);
      const rest = line.slice(space + 1);
      const command = rest.toUpperCase();
      fake.commands.push(rest);
      if (fake.failOn !== null && command.startsWith(fake.failOn)) {
        fake.failOn = null;
        socket.destroy();
        return;
      }
      if (command === "CAPABILITY") {
        send(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`);
      } else if (command.startsWith("AUTHENTICATE PLAIN")) {
        challenge = tag;
        send("+ \r\n");
      } else if (command === "LOGOUT") {
        send(`* BYE bye\r\n${tag} OK done\r\n`);
        socket.end();
      } else if (!authed) {
        send(`${tag} NO sign in first\r\n`);
      } else if (command.startsWith("LIST") || command.startsWith("LSUB")) {
        const kind = command.slice(0, 4);
        send(
          command.includes('"INBOX"')
            ? `* ${kind} (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`
            : `* ${kind} (\\Noselect) "/" ""\r\n${tag} OK done\r\n`,
        );
      } else if (command.startsWith("SELECT")) {
        if (!/^SELECT "?INBOX"?$/.test(command)) {
          send(`${tag} NO no such folder\r\n`);
          return;
        }
        send(
          `* ${fake.messages.length} EXISTS\r\n* FLAGS (\\Seen \\Flagged)\r\n` +
            `* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT ${(fake.messages.at(-1)?.uid ?? 0) + 1}] ok\r\n` +
            `${tag} OK [READ-WRITE] done\r\n`,
        );
      } else if (command === "UID SEARCH UNSEEN") {
        const unseen = fake.messages.filter((m) => !m.flags.has("\\Seen")).map((m) => m.uid);
        send(`* SEARCH${unseen.map((u) => ` ${u}`).join("")}\r\n${tag} OK done\r\n`);
      } else if (command.startsWith("UID FETCH")) {
        const [, ids, items] = /^UID FETCH (\S+) \((.*)\)$/.exec(command) as unknown as [
          string,
          string,
          string,
        ];
        for (const m of select(ids)) {
          const seq = fake.messages.indexOf(m) + 1;
          const parts = [`UID ${m.uid}`];
          if (items.includes("RFC822.SIZE")) parts.push(`RFC822.SIZE ${m.raw.length}`);
          if (items.includes("BODY.PEEK[]")) {
            send(`* ${seq} FETCH (${parts.join(" ")} BODY[] {${m.raw.length}}\r\n`);
            socket.write(m.raw);
            send(")\r\n");
          } else send(`* ${seq} FETCH (${parts.join(" ")})\r\n`);
        }
        send(`${tag} OK done\r\n`);
      } else if (command.startsWith("UID STORE")) {
        const [, ids, flags] = /^UID STORE (\S+) \+FLAGS(?:\.SILENT)? \((.*)\)$/i.exec(
          rest,
        ) as unknown as [string, string, string];
        for (const m of select(ids)) for (const f of flags.split(" ")) m.flags.add(f);
        send(`${tag} OK done\r\n`);
      } else {
        send(`${tag} OK noted\r\n`);
      }
    };
    send("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n");
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let at = buffer.indexOf("\r\n"); at >= 0; at = buffer.indexOf("\r\n")) {
        const line = buffer.subarray(0, at).toString();
        buffer = buffer.subarray(at + 2);
        handle(line);
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  fake.port = (server.address() as { port: number }).port;
  return fake;
}
