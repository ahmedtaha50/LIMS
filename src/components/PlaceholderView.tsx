import React from 'react';
import { Construction } from 'lucide-react';

export function PlaceholderView({ title, description }: { title: string, description: string }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-12 flex flex-col items-center justify-center text-center h-[calc(100vh-8rem)]">
      <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-6">
        <Construction className="w-10 h-10 text-slate-400" />
      </div>
      <h2 className="text-2xl font-bold text-slate-900 mb-2">{title}</h2>
      <p className="text-slate-500 max-w-md">
        {description}
      </p>
      <div className="mt-8 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg text-sm font-medium border border-blue-100">
        This module is scheduled for the next development phase.
      </div>
    </div>
  );
}
