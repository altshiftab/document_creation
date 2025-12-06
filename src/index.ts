import type {Page} from "puppeteer";
import {getDocument} from "pdfjs-dist/legacy/build/pdf.mjs";
import {PDFDocument} from "pdf-lib";
import type {PDFPage} from "pdf-lib";
import {html} from "lit";
import type {TemplateResult} from 'lit';
import {render} from '@lit-labs/ssr';

export interface Header {
    name: string;
    displayName: string
    level: number;
}

export interface PagedHeader extends Header {
    page: number;
}

async function templateToString(tpl: TemplateResult): Promise<string> {
    let out = '';
    for await (const chunk of render(tpl)) {
        out += chunk;
    }
    return out;
}

export function makeTableOfContents(pagedHeaders: PagedHeader[]){
    return templateToString(
        html`
            <style>
                @page {
                    size: A4;
                    margin: 0.4in;
                }
                
                .rows-container {
                    display: grid;
                    grid-template-columns: 1fr auto;
                    gap: 1em;
                    
                    > .row {
                        display: contents;
                        
                        > .title {
                            font-weight: 700;
                            --indent-step: 1.25em;
                            padding-inline-start: calc((var(--level) - 1) * var(--indent-step));
                        }
                    }
                }
            </style>
            <h1>Table of Contents</h1>
            <section class="rows-container">
                ${pagedHeaders.map(header => html`<div class="row"><span class="title" style="${`--level: ${header.level}`}">${header.name}</span><span class="page">${header.page}</span></div>`)}
            </section>
        `
    );
}

export async function extractHeaders(page: Page): Promise<Header[]> {
    const session = await page.createCDPSession();

    try {
        const {nodes} = await session.send("Accessibility.getFullAXTree");
        const headingNodes = nodes.filter(node => node.role?.value === "heading");

        const headers: Header[] = [];

        for (const node of headingNodes) {
            const backendNodeId = node.backendDOMNodeId;
            if (!backendNodeId)
                continue;

            const {object} = await session.send('DOM.resolveNode', {backendNodeId});
            const {result} = await session.send('Runtime.callFunctionOn', {
                objectId: object.objectId,
                functionDeclaration: 'function () { return this.textContent; }',
                returnByValue: true,
            });

            const name = result.value ?? "";
            if (!name)
                throw new Error("name is undefined");

            const displayName = node.name?.value;
            if (!displayName)
                throw new Error("displayName is undefined");

            const level = node.properties?.find(p => p.name === "level")?.value?.value;
            if (!level)
                throw new Error("level is undefined");

            headers.push({name, displayName, level});
        }

        return headers;
    } finally {
        await session.detach();
    }
}

function isTextItem(item: any): item is { str: string } {
    return item && typeof item.str === "string";
}

export async function getPagedHeaders(pdfData: Uint8Array, headers: Header[]) {
    const pdfDocument = await getDocument({
        data: pdfData,
        isEvalSupported: false,
        disableFontFace: true,
    }).promise;

    const headersIterator = function*() {
        for (const header of headers) {
            yield header;
        }
    }();

    let {done, value: currentHeader} = headersIterator.next();
    if (done)
        return [];
    if (currentHeader === undefined)
        throw new Error("currentHeader is undefined");


    let currentSegment: {text: string, height?: number} | undefined;

    const pagedHeaders: PagedHeader[] = [];

    try {
        pageLoop:
        for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
            const page = await pdfDocument.getPage(pageNum);

            for (const item of (await page.getTextContent()).items) {
                if (!isTextItem(item))
                    continue;

                const text = item.str;
                if (!text)
                    continue;

                const height = item.height ?? Math.abs(item.transform?.[3] ?? 0);

                if (currentSegment === undefined) {
                    if (text === " ")
                        continue

                    currentSegment = {text, height};
                } else {
                    if (currentSegment.height === height || text === " ") {
                        currentSegment.text += text;
                    } else {
                        if (currentSegment.text === currentHeader.displayName) {
                            pagedHeaders.push({
                                ...currentHeader,
                                page: pageNum,
                            });

                            let {done: localDone, value: header} = headersIterator.next();
                            done = localDone;
                            if (done)
                                break pageLoop;
                            if (header === undefined)
                                throw new Error("currentHeader is undefined");

                            currentHeader = header;
                        }

                        currentSegment = {text, height};
                    }
                }
            }
        }

        if (!done)
            throw new Error("all headers not matched")

        return pagedHeaders;
    } finally {
        await pdfDocument.destroy();
    }
}

export async function prependPages(document: Uint8Array, ...sources: Uint8Array[]): Promise<Uint8Array> {
    const pdfDocument = await PDFDocument.load(document);

    const pagesToInsert: PDFPage[] = [];
    for (const src of await Promise.all(sources.map((s) => PDFDocument.load(s)))) {
        pagesToInsert.push(
            ...await pdfDocument.copyPages(src, Array.from({ length: src.getPageCount() }, (_, i) => i))
        );
    }

    for (let i = pagesToInsert.length - 1; i >= 0; i--)
        pdfDocument.insertPage(0, pagesToInsert[i]);

    return pdfDocument.save();
}
