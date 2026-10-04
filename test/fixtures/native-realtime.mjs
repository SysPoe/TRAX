const crcTable = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit++) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

/** Build an in-memory stored ZIP for the real native static parser. */
export function staticZip(files) {
	const localParts = [],
		centralParts = [];
	let offset = 0;
	for (const [filename, contents] of Object.entries(files)) {
		const name = Buffer.from(filename),
			body = Buffer.from(contents);
		let crc = 0xffffffff;
		for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
		crc = (crc ^ 0xffffffff) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(body.length, 22);
		local.writeUInt16LE(name.length, 26);
		localParts.push(local, name, body);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(body.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		centralParts.push(central, name);
		offset += local.length + name.length + body.length;
	}
	const directory = Buffer.concat(centralParts),
		end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, directory, end]);
}

function varint(value) {
	let remaining = BigInt(value);
	const bytes = [];
	do {
		let byte = Number(remaining & 127n);
		remaining >>= 7n;
		if (remaining) byte |= 128;
		bytes.push(byte);
	} while (remaining);
	return Buffer.from(bytes);
}
const scalar = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const message = (field, value) => {
	const body = typeof value === "string" ? Buffer.from(value) : value;
	return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
};

/** Encode TripDescriptors without enum validation so unsupported status handling fails in consumers. */
export function realtimeFeed(updates) {
	const entities = updates.map(
		({
			id,
			tripId = "t",
			date,
			relationship = 0,
			startTime,
			timestamp = Math.floor(Date.now() / 1000),
			calls = [],
		}) => {
			const trip = Buffer.concat([
				message(1, tripId),
				...(startTime == null ? [] : [message(2, startTime)]),
				message(3, date),
				scalar(4, relationship),
				message(5, "r"),
			]);
			const stops = calls.map(({ stopId, sequence, at }) =>
				message(
					2,
					Buffer.concat([
						scalar(1, sequence),
						message(2, scalar(2, at)),
						message(3, scalar(2, at)),
						message(4, stopId),
					]),
				),
			);
			const update = Buffer.concat([message(1, trip), ...stops, scalar(4, timestamp)]);
			return message(
				2,
				Buffer.concat([
					message(1, id ?? `${tripId}-${date}-${startTime ?? ""}-${relationship}`),
					message(3, update),
				]),
			);
		},
	);
	return Buffer.concat([message(1, Buffer.concat([message(1, "2.0"), scalar(3, 100)])), ...entities]);
}
