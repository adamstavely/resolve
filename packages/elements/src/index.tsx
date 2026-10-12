import React, { useId, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Button } from './components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from './components/ui/dialog';
import { Input } from './components/ui/input';
import { Label } from './components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from './components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './components/ui/command';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table';
function Lab({host}:{host:HTMLElement}) {
 const [open,setOpen]=useState(false), [picker,setPicker]=useState(false), [value,setValue]=useState(''), [name,setName]=useState(''), [saved,setSaved]=useState(''); const id=useId();
 return <div className="stack">
 <section className="panel stack" aria-labelledby={id+'title'}><h2 id={id+'title'}>Component integration</h2><p className="muted">A local interaction check. This form does not register an application or contact Quackback.</p>
 <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button className="w-fit">Open integration check</Button></DialogTrigger>
 <DialogContent><DialogHeader><DialogTitle>Check a local preference</DialogTitle><DialogDescription>Exercise keyboard navigation and the Angular event bridge. Nothing is saved to a server.</DialogDescription></DialogHeader>
 <form className="stack" onSubmit={e=>{e.preventDefault();if(!value)return;setSaved(name+' · '+value);host.dispatchEvent(new CustomEvent('preference-change',{detail:{name,theme:value},bubbles:true,composed:true}));setOpen(false);}}>
 <div className="stack"><Label htmlFor={id+'name'}>Display name</Label><Input id={id+'name'} value={name} onChange={e=>setName(e.target.value)} required maxLength={80}/></div>
 <div className="stack"><Label id={id+'theme'}>Preferred appearance</Label><Popover open={picker} onOpenChange={setPicker}><PopoverTrigger asChild><Button variant="outline" role="combobox" aria-labelledby={id+'theme'} aria-expanded={picker}>{value||'Choose appearance'}</Button></PopoverTrigger><PopoverContent><Command><CommandInput placeholder="Find appearance…" aria-label="Find appearance"/><CommandList><CommandEmpty>No matching appearance.</CommandEmpty>{['Light','Dark','System'].map(v=><CommandItem key={v} value={v} onSelect={()=>{setValue(v);setPicker(false);}}>{v}</CommandItem>)}</CommandList></Command></PopoverContent></Popover></div>
 {!value&&<p className="muted">Choose an appearance before saving.</p>}<Button type="submit" disabled={!value}>Save local preference</Button></form></DialogContent></Dialog>
 <p role="status">{saved ? 'Local preference: '+saved : 'No preference selected.'}</p></section>
 <section className="panel"><h2>Foundation boundaries</h2><Table><TableCaption>Implementation status, not live fleet data.</TableCaption><TableHeader><TableRow><TableHead>Boundary</TableHead><TableHead>Current behavior</TableHead></TableRow></TableHeader><TableBody>{[['Console','Angular hosts registered Web Components'],['Controls','Official shadcn components, rendered with React'],['Backend','Next.js route handlers on Node.js'],['Tenant access','Not connected; no operator actions exposed']].map(([a,b])=><TableRow key={a}><TableCell>{a}</TableCell><TableCell>{b}</TableCell></TableRow>)}</TableBody></Table></section></div>;
}
export function registerElements() {
 if(customElements.get('resolve-lab')) return;
 class ResolveLab extends HTMLElement {
  private root?:Root;
  connectedCallback(){ if(!this.root){this.root=createRoot(this);this.root.render(<Lab host={this}/>);} }
  disconnectedCallback(){queueMicrotask(()=>{if(!this.isConnected){this.root?.unmount();this.root=undefined;}});}
 }
 customElements.define('resolve-lab',ResolveLab);
}
