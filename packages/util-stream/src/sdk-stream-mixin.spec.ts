import { SdkStreamMixin } from "@smithy/types";
import { fromArrayBuffer } from "@smithy/util-buffer-from";
import { PassThrough, Readable, Writable } from "stream";
import { afterAll, beforeAll, beforeEach, describe, expect, test as it, vi } from "vitest";

import { sdkStreamMixin } from "./sdk-stream-mixin";

vi.mock("@smithy/util-buffer-from");

describe(sdkStreamMixin.name, () => {
  const writeDataToStream = (stream: Writable, data: Array<ArrayBufferLike>): Promise<void> =>
    new Promise((resolve, reject) => {
      data.forEach((chunk) => {
        stream.write(chunk, (err) => {
          if (err) reject(err);
        });
      });
      stream.end(resolve);
    });
  const byteArrayFromBuffer = (buf: Buffer) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let passThrough: PassThrough;
  const expectAllTransformsToFail = async (sdkStream: SdkStreamMixin) => {
    const transformMethods: Array<keyof SdkStreamMixin> = [
      "transformToByteArray",
      "transformToString",
      "transformToWebStream",
    ];
    for (const method of transformMethods) {
      try {
        await sdkStream[method]();
        fail(new Error("expect subsequent transform to fail"));
      } catch (error) {
        expect(error.message).toContain("The stream has already been transformed");
      }
    }
  };

  beforeEach(() => {
    passThrough = new PassThrough();
  });

  it("should attempt to use the ReadableStream version if the input is not a Readable", async () => {
    if (typeof ReadableStream !== "undefined") {
      // ReadableStream is global only as of Node.js 18.
      const sdkStream = sdkStreamMixin(
        new ReadableStream({
          start(controller) {
            controller.enqueue(Buffer.from("abcd"));
            controller.close();
          },
        })
      );
      expect(await sdkStream.transformToByteArray()).toEqual(new Uint8Array([97, 98, 99, 100]));
    }
  });

  it("should throw if unexpected stream implementation is supplied", () => {
    try {
      const payload = {};
      sdkStreamMixin(payload);
      fail("should throw when unexpected stream is supplied");
    } catch (error) {
      expect(error.message).toContain("Unexpected stream implementation");
    }
  });

  describe("transformToByteArray", () => {
    it("should transform binary stream to byte array", async () => {
      const mockData = [Buffer.from("foo"), Buffer.from("bar"), Buffer.from("buzz")];
      const expected = byteArrayFromBuffer(Buffer.from("foobarbuzz"));
      const sdkStream = sdkStreamMixin(passThrough);
      await writeDataToStream(passThrough, mockData);
      expect(await sdkStream.transformToByteArray()).toEqual(expected);
    });

    it("should fail any subsequent transform calls", async () => {
      const sdkStream = sdkStreamMixin(passThrough);
      await writeDataToStream(passThrough, [Buffer.from("abc")]);
      expect(await sdkStream.transformToByteArray()).toEqual(byteArrayFromBuffer(Buffer.from("abc")));
      await expectAllTransformsToFail(sdkStream);
    });
  });

  describe("transformToString", () => {
    const toStringMock = vi.fn();
    beforeAll(() => {
      vi.resetAllMocks();
    });

    it("should transform the stream to string with utf-8 encoding by default", async () => {
      vi.mocked(fromArrayBuffer).mockImplementation(
        ((await vi.importActual("@smithy/util-buffer-from")) as any).fromArrayBuffer
      );
      const sdkStream = sdkStreamMixin(passThrough);
      await writeDataToStream(passThrough, [Buffer.from("foo")]);
      const transformed = await sdkStream.transformToString();
      expect(transformed).toEqual("foo");
    });

    it.each([undefined, "utf-8", "ascii", "base64", "latin1", "binary"])(
      "should transform the stream to string with %s encoding",
      async (encoding) => {
        vi.mocked(fromArrayBuffer).mockReturnValue({ toString: toStringMock } as any);
        const sdkStream = sdkStreamMixin(passThrough);
        await writeDataToStream(passThrough, [Buffer.from("foo")]);
        await sdkStream.transformToString(encoding);
        expect(toStringMock).toBeCalledWith(encoding);
      }
    );

    it.each(["ibm866", "iso-8859-2", "koi8-r", "macintosh", "windows-874", "gbk", "gb18030", "euc-jp"])(
      "should transform the stream to string with TextDecoder config %s",
      async (encoding) => {
        vi.spyOn(global, "TextDecoder").mockImplementation(
          () =>
            ({
              decode: vi.fn(),
            }) as any
        );
        vi.mocked(fromArrayBuffer).mockReturnValue({ toString: toStringMock } as any);
        const sdkStream = sdkStreamMixin(passThrough);
        await writeDataToStream(passThrough, [Buffer.from("foo")]);
        await sdkStream.transformToString(encoding as BufferEncoding);
        expect(TextDecoder).toBeCalledWith(encoding);
      }
    );

    it("should fail any subsequent transform calls", async () => {
      const sdkStream = sdkStreamMixin(passThrough);
      await writeDataToStream(passThrough, [Buffer.from("foo")]);
      await sdkStream.transformToString();
      await expectAllTransformsToFail(sdkStream);
    });
  });

  describe("transformToWebStream", () => {
    it("should throw if any event listener is attached on the underlying stream", async () => {
      passThrough.on("data", console.log);
      const sdkStream = sdkStreamMixin(passThrough);
      try {
        sdkStream.transformToWebStream();
        fail(new Error("expect web stream transformation to fail"));
      } catch (error) {
        expect(error.message).toContain("The stream has been consumed by other callbacks");
      }
    });

    describe("when Readable.toWeb() is not supported", () => {
      const originalToWebImpl = Readable.toWeb;
      beforeAll(() => {
        // @ts-expect-error
        Readable.toWeb = undefined;
      });
      afterAll(() => {
        Readable.toWeb = originalToWebImpl;
      });

      it("should throw", async () => {
        const sdkStream = sdkStreamMixin(passThrough);
        try {
          sdkStream.transformToWebStream();
          fail(new Error("expect web stream transformation to fail"));
        } catch (error) {
          expect(error.message).toContain("Readable.toWeb() is not supported");
        }
      });
    });

    describe("when Readable.toWeb() is supported", () => {
      const originalToWebImpl = Readable.toWeb;
      beforeAll(() => {
        Readable.toWeb = vi.fn().mockReturnValue("A web stream");
      });

      afterAll(() => {
        Readable.toWeb = originalToWebImpl;
      });

      it("should transform Node stream to web stream", async () => {
        const sdkStream = sdkStreamMixin(passThrough);
        sdkStream.transformToWebStream();
        expect(Readable.toWeb).toBeCalled();
      });

      it("should fail any subsequent transform calls", async () => {
        const sdkStream = sdkStreamMixin(passThrough);
        await writeDataToStream(passThrough, [Buffer.from("foo")]);
        await sdkStream.transformToWebStream();
        await expectAllTransformsToFail(sdkStream);
      });
    });
  });
});
